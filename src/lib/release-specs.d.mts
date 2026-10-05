export type HalfBuiltSpec = {
  number: number;
  title: string;
  url: string;
  closedTickets: number;
  totalTickets: number;
  /** `#N Title: C of T Tickets closed`. */
  summary: string;
};

export type HalfBuiltSpecs =
  | { checked: true; specs: HalfBuiltSpec[] }
  | { checked: false; reason: string };

export type GraphqlRunner = (query: string) => Promise<unknown>;

export function commitIssue(description: string | null | undefined, repository: string | null): number | null;
export function halfBuiltSpecs(
  repository: string | null,
  descriptions: string[],
  options?: { graphql?: GraphqlRunner },
): Promise<HalfBuiltSpecs>;
