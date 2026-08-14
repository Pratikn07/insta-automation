// The funnel registry.
//
// Adding a funnel later should mean adding a definition here, not building a
// page. The five other funnels already latent in the schema — historical
// recovery (RecoveryCandidateOutcome), DM recovery reminders (DmRecoveryStatus),
// public recovery dispatch (PublicRecoveryDispatchState), AI reply drafts
// (ReplyDraftStatus) and per-reel capture — all fit this shape.
//
// Two of those carry a control arm already (DmRecoveryCohort.control,
// RecoveryCandidateArm.holdout), which means their funnels can report LIFT over
// control rather than a bare conversion rate. Leaving room for that here is the
// reason FunnelDef is a data structure and not a function.

import type { FunnelDef } from "./types.js";
import { guideFollowDef } from "./guideFollowFunnel.js";

export const FUNNELS: Record<string, FunnelDef> = {
  [guideFollowDef.key]: guideFollowDef,
};

export const FUNNEL_KEYS = Object.keys(FUNNELS);

export function getFunnelDef(key: string): FunnelDef | null {
  return FUNNELS[key] ?? null;
}
