import type { AiProposalStatus } from "../desktop";

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
