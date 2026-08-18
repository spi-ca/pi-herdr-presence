import { types } from "node:util";

const COORDINATOR_ABI = "pi-herdr-presence/process-coordinator/v1";
const COORDINATOR_SLOT = Symbol.for(COORDINATOR_ABI);

type Lease = object;
type AuthorityWork<T> = () => Promise<T>;

export type ProcessCoordinator = Readonly<{
  abi: typeof COORDINATOR_ABI;
  enqueueAuthority<T>(work: AuthorityWork<T>): Promise<T>;
  claimAuthority(): number;
  isAuthority(generation: number): boolean;
  releaseAuthority(generation: number): void;
  acquireOfficialProbe(): Lease | null;
  releaseOfficialProbe(lease: Lease): void;
  acquireSocketFingerprint(): Lease | null;
  releaseSocketFingerprint(lease: Lease): void;
  nextSequence(): number | undefined;
}>;

function ownDataDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor : undefined;
}

function isFrozenDataDescriptor(descriptor: PropertyDescriptor): boolean {
  return descriptor.configurable === false && descriptor.enumerable === false && descriptor.writable === false;
}

/** Accept only the frozen ABI shape that this same-runtime extension installs. */
function isCoordinator(value: unknown): value is ProcessCoordinator {
  // Same-realm extensions are trusted code, but reject proxies before any
  // reflective operation so a malformed global cannot execute traps here.
  if (typeof value !== "object" || value === null || types.isProxy(value)) return false;
  if (Object.getPrototypeOf(value) !== null || !Object.isFrozen(value) || Reflect.ownKeys(value).length !== 10) return false;
  const abi = ownDataDescriptor(value, "abi");
  if (!abi || !isFrozenDataDescriptor(abi) || abi.value !== COORDINATOR_ABI) return false;
  for (const key of ["enqueueAuthority", "claimAuthority", "isAuthority", "releaseAuthority", "acquireOfficialProbe", "releaseOfficialProbe", "acquireSocketFingerprint", "releaseSocketFingerprint", "nextSequence"] as const) {
    const descriptor = ownDataDescriptor(value, key);
    // Reading an own descriptor does not invoke an accessor. Reject a proxied
    // method before inspecting descriptor attributes or invoking the method.
    if (!descriptor || typeof descriptor.value !== "function" || types.isProxy(descriptor.value) || !isFrozenDataDescriptor(descriptor)) return false;
  }
  return true;
}

function createCoordinator(): ProcessCoordinator {
  let authorityLane: Promise<void> = Promise.resolve();
  let authorityGeneration = 0;
  let activeAuthority: number | null = null;
  let officialProbe: Lease | null = null;
  let socketFingerprint: Lease | null = null;
  let lastSequence = 0;
  const acquire = (kind: "official" | "socket"): Lease | null => {
    if (kind === "official") {
      if (officialProbe) return null;
      const lease = {};
      officialProbe = lease;
      return lease;
    }
    if (socketFingerprint) return null;
    const lease = {};
    socketFingerprint = lease;
    return lease;
  };
  const release = (kind: "official" | "socket", lease: Lease): void => {
    if (kind === "official") { if (officialProbe === lease) officialProbe = null; return; }
    if (socketFingerprint === lease) socketFingerprint = null;
  };
  const coordinator = Object.create(null) as {
    abi: typeof COORDINATOR_ABI;
    enqueueAuthority: ProcessCoordinator["enqueueAuthority"];
    claimAuthority: ProcessCoordinator["claimAuthority"];
    isAuthority: ProcessCoordinator["isAuthority"];
    releaseAuthority: ProcessCoordinator["releaseAuthority"];
    acquireOfficialProbe: ProcessCoordinator["acquireOfficialProbe"];
    releaseOfficialProbe: ProcessCoordinator["releaseOfficialProbe"];
    acquireSocketFingerprint: ProcessCoordinator["acquireSocketFingerprint"];
    releaseSocketFingerprint: ProcessCoordinator["releaseSocketFingerprint"];
    nextSequence: ProcessCoordinator["nextSequence"];
  };
  coordinator.abi = COORDINATOR_ABI;
  coordinator.enqueueAuthority = <T>(work: AuthorityWork<T>): Promise<T> => {
    // The coordinator only sequences extension-owned promises; it never invokes
    // or awaits a Pi host callback while holding an authority slot.
    const result = authorityLane.then(work, work);
    authorityLane = result.then(() => undefined, () => undefined);
    return result;
  };
  coordinator.claimAuthority = () => {
    if (authorityGeneration >= Number.MAX_SAFE_INTEGER) throw new Error("Herdr authority generation space is exhausted.");
    authorityGeneration += 1;
    activeAuthority = authorityGeneration;
    return authorityGeneration;
  };
  coordinator.isAuthority = (generation) => activeAuthority === generation;
  coordinator.releaseAuthority = (generation) => { if (activeAuthority === generation) activeAuthority = null; };
  coordinator.acquireOfficialProbe = () => acquire("official");
  coordinator.releaseOfficialProbe = (lease) => release("official", lease);
  coordinator.acquireSocketFingerprint = () => acquire("socket");
  coordinator.releaseSocketFingerprint = (lease) => release("socket", lease);
  coordinator.nextSequence = () => {
    const timestamp = Math.floor(Date.now() * 1000);
    // An invalid or unrepresentable forward clock reading must not advance the
    // high-water mark: callers fail closed rather than manufacturing a value.
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || lastSequence >= Number.MAX_SAFE_INTEGER) return undefined;
    const next = Math.max(Math.min(Number.MAX_SAFE_INTEGER, timestamp + 1), lastSequence + 1);
    if (!Number.isSafeInteger(next) || next > Number.MAX_SAFE_INTEGER) return undefined;
    lastSequence = next;
    return next;
  };
  for (const key of Reflect.ownKeys(coordinator)) {
    const value = coordinator[key as keyof typeof coordinator];
    Object.defineProperty(coordinator, key, { value, configurable: false, enumerable: false, writable: false });
  }
  return Object.freeze(coordinator);
}

function installCoordinator(): ProcessCoordinator {
  const existing = Object.getOwnPropertyDescriptor(globalThis, COORDINATOR_SLOT);
  if (existing) {
    if (existing.configurable || existing.enumerable || existing.writable || !isCoordinator(existing.value)) throw new Error("Invalid pi-herdr-presence process coordinator.");
    return existing.value;
  }
  const coordinator = createCoordinator();
  Object.defineProperty(globalThis, COORDINATOR_SLOT, { value: coordinator, configurable: false, enumerable: false, writable: false });
  const installed = Object.getOwnPropertyDescriptor(globalThis, COORDINATOR_SLOT);
  if (!installed || installed.value !== coordinator || installed.configurable || installed.enumerable || installed.writable || !isCoordinator(installed.value)) throw new Error("Unable to install pi-herdr-presence process coordinator.");
  return coordinator;
}

export const processCoordinator = installCoordinator();
