export interface Principal {
  readonly subjectId: string;
  readonly sessionId?: string;
  readonly assuranceLevel: number;
  readonly permissions: ReadonlySet<string>;
  readonly scopes: Readonly<Record<string, readonly string[]>>;
}

export interface AuthenticatedIdentity {
  readonly subjectId: string;
  readonly sessionId?: string;
  readonly assuranceLevel: number;
}

export interface AuthorizationRequirement {
  readonly permission: string;
  readonly stepUpLevel?: number;
}
