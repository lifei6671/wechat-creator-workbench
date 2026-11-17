import type { AiProposalStatus, AiPropertyValues } from "../desktop";

export interface AiPropertyProposal {
  id: string;
  entryId: string;
  values: AiPropertyValues;
}

export interface AiProposal {
  id: string;
  entryId: string;
  baseVersion: number;
  localRevision: number;
  from: number;
  to: number;
  originalMarkdown: string;
  originalSliceHash: string;
  replacementMarkdown: string;
  description: string;
  status: AiProposalStatus;
}
