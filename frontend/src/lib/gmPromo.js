// Time-boxed free-play promo for the NW Coaching Simulator (the /gm game).
//
// While the current time is before GM_FREE_PLAY_UNTIL, the Sim is open to
// every signed-in user — no paid subscription required. A free account is
// still needed (dynasty saves are tied to an account, and it nudges signups).
// After the cutoff the normal gate resumes automatically (early-access
// allowlist + Premium/Coach/Dev tiers) with no code change or redeploy.
//
// Set during the 2026-05-31 launch week. To end the promo early, move this
// date into the past; to extend it, push it later.
export const GM_FREE_PLAY_UNTIL = new Date('2026-06-08T00:00:00-07:00') // midnight Pacific, start of Jun 8

export function isGmFreePlay(now = new Date()) {
  return now < GM_FREE_PLAY_UNTIL
}
