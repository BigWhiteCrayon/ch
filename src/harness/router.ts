// Chooses the model that serves a request, from its classification.
//
// The rule: use the least sophisticated model that still meets the level the
// request needs, so capable (and costly) models are kept for requests that
// call for them. A local model wins a tie because it is free to run.

import { SOPHISTICATION, bySophistication } from '../llm/sophistication';
import type { Classification, ModelInfo, RouteReason } from '../types';

// Which side of the machine a request would rather be served by, when what
// matters is not cost or capability but which queue it joins. A local provider
// serves one request at a time (see ../llm/ollama.ts), so a long background
// job and the user's own message both routed local means the user waits behind
// the background job. The preference is what keeps those two apart.
export type Prefer = 'local' | 'hosted';

// How far a preference may give up to be honoured. Keeping work off a queue is
// worth a level of sophistication; it is not worth handing the work to a model
// too small to do it (see fromParameterCount in ../llm/sophistication.ts).
// Below this the preference is dropped and the ordinary rule decides.
export const PREFERENCE_FLOOR = SOPHISTICATION.CAPABLE;

// The level a request is assumed to need when the classifier could not say
export const UNCLASSIFIED_LEVEL = SOPHISTICATION.CAPABLE;

// Least sophisticated first; local before hosted at the same level
export function cheapestFirst(
  a: Pick<ModelInfo, 'sophistication' | 'local'>,
  b: Pick<ModelInfo, 'sophistication' | 'local'>
): number {
  return a.sophistication - b.sophistication || Number(b.local) - Number(a.local);
}

export interface Route {
  provider: string;
  id: string;
  name: string;
  sophistication?: number;
  // See ProviderModel.reasons
  reasons?: boolean;
  reason: RouteReason;
}

// models: the enabled models, as returned by llm.listModels()
// classification: the classifier's result (may have failed), or just the
// level a request needs
// request: provider and model are set if the user picked a model themselves.
// vision: the request carries images, so only a model that takes them is
// chosen, where there is one (otherwise the images go to whatever is chosen)
// Returns the chosen model with a reason, or null if there are no models.
// prefer: which side to serve this from if that side can, whatever the other
// side has. Left out, the ordinary rule decides. Nothing is forced: if the
// preferred side has no model worth the work — as when offline leaves no
// hosted models at all (see ../llm/index.ts) — the preference is dropped
// rather than the request failing.
export function route(
  models: ModelInfo[],
  classification: Classification | { failed?: false; sophistication: number },
  request: { provider?: string; model?: string; vision?: boolean },
  prefer?: Prefer
): Route | null {
  // Level-0 models are for system tasks such as classification, never for replies
  const replying = models.filter((m) => m.sophistication !== SOPHISTICATION.ZERO);
  const seeing = replying.filter((m) => m.vision !== false);
  const usable = request.vision && seeing.length > 0 ? seeing : replying;

  if (request.provider && request.model) {
    const picked = models.find((m) => m.provider === request.provider && m.id === request.model);
    // Still serve an explicit pick the list doesn't know; the provider will report any problem
    return {
      ...(picked ?? { provider: request.provider, id: request.model, name: request.model }),
      reason: 'picked',
    };
  }
  if (usable.length === 0) return null;

  if (classification.failed) {
    // Nothing to go on: serve it as a request needing the next level above the
    // basics, so a model that is not the default can still be the one chosen
    const assumed = route(usable, { sophistication: UNCLASSIFIED_LEVEL }, {}, prefer);
    return assumed && { ...assumed, reason: 'unclassified' };
  }

  const enough = (set: ModelInfo[]) => set.filter((m) => m.sophistication >= classification.sophistication);

  if (prefer) {
    const side = usable.filter((m) => m.local === (prefer === 'local'));
    const fits = enough(side).sort(cheapestFirst);
    if (fits.length > 0) return { ...fits[0], reason: 'matched' };
    // Nothing on the preferred side is as capable as the work asks for. Its
    // best is still the right choice while the point is to leave the other
    // side clear — so long as its best is a model worth the work.
    const best = [...side].sort(bySophistication)[0];
    if (best && best.sophistication >= PREFERENCE_FLOOR) return { ...best, reason: 'preferred' };
  }

  const sufficient = enough(usable).sort(cheapestFirst);
  if (sufficient.length > 0) return { ...sufficient[0], reason: 'matched' };

  // Nothing is capable enough, so use the best there is (the list is sorted smartest first)
  return { ...usable[0], reason: 'best_available' };
}

// What route() would choose from only the models at or below a sophistication
// ceiling, for when the user has not approved anything above it. If nothing is
// that modest, the least sophisticated model there is (the last, as the list is
// sorted smartest first) stands in. Returns null if there are no models.
// vision: as for route()
export function capped(
  models: ModelInfo[],
  classification: Classification | { failed?: false; sophistication: number },
  ceiling: number,
  prefer?: Prefer,
  vision?: boolean
): Route | null {
  const allowed = models.filter((m) => m.sophistication <= ceiling);
  const chosen = route(allowed.length > 0 ? allowed : models.slice(-1), classification, { vision }, prefer);
  return chosen && { ...chosen, reason: 'not_approved' };
}
