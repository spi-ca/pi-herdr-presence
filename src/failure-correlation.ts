export type FailureRepresentation = {
  source: string;
  generation: number;
  sequence: number;
  kind: "state" | "terminal";
  acceptedAt: number;
  eventId?: number;
};

type Candidate = FailureRepresentation & { key: string };

/**
 * Bounded semantic pairing for the two V2 representations of one failure.
 * The protocol has no shared failure ID, so this deliberately retains only the
 * newest candidate for each source and pairs only adjacent accepted sequences.
 * V2 does not expose producer deactivation or incarnation events, so a silent
 * same-source restart inside this horizon remains indistinguishable; normal
 * withdrawal, generation, and session boundaries clear the candidate.
 */
export class FailureCorrelation {
  private readonly candidates = new Map<string, Candidate>();

  constructor(private readonly horizonMs = 100, private readonly limit = 64) {}

  accept(representation: FailureRepresentation): string {
    this.purge(representation.acceptedAt);
    const candidate = this.candidates.get(representation.source);
    if (candidate
      && candidate.generation === representation.generation
      && candidate.kind !== representation.kind
      && representation.sequence === candidate.sequence + 1
      && representation.acceptedAt >= candidate.acceptedAt
      && representation.acceptedAt - candidate.acceptedAt <= this.horizonMs) {
      this.candidates.delete(representation.source);
      return candidate.key;
    }

    // Any same-source event that did not meet every pairing condition is an
    // ambiguity boundary. Replace its candidate rather than searching older
    // history, including for repeated failure representations.
    const key = this.key(representation);
    this.candidates.delete(representation.source);
    this.candidates.set(representation.source, { ...representation, key });
    while (this.candidates.size > this.limit) {
      const oldest = this.candidates.keys().next().value;
      if (oldest === undefined) break;
      this.candidates.delete(oldest);
    }
    return key;
  }

  /** A semantic exit, non-failed terminal, withdrawal, or source reset breaks pairing. */
  boundary(source: string, _generation?: number) {
    this.candidates.delete(source);
  }

  clear() { this.candidates.clear(); }

  private purge(acceptedAt: number) {
    for (const [source, candidate] of this.candidates) {
      if (acceptedAt >= candidate.acceptedAt && acceptedAt - candidate.acceptedAt > this.horizonMs)
        this.candidates.delete(source);
    }
  }

  private key(representation: FailureRepresentation): string {
    return `failure:${representation.source}:${representation.generation}:${representation.kind}:${representation.sequence}:${representation.eventId ?? ""}`;
  }
}
