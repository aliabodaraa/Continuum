// What a check's signed token says, and what the user's pushed state is, given this check's verdict and each channel's
// last settled verdict (2026-11-08). A channel's state changes only on a settled verdict (genuine or suspicious);
// warm-up leaves it as it was. The user is suspicious while any channel is, and the token is suspicious then too, so a
// genuine mouse verdict no longer clears a suspicious typing verdict, at the organisation or in the SDK's token.
const CHANNELS = ["keystroke", "mouse"];
const settled = (v) => v === "genuine" || v === "suspicious";

function combine(modality, risk, stored) {
  const states = {};
  for (const ch of CHANNELS) states[ch] = ch === modality && settled(risk) ? risk : (stored || {})[ch];
  const any = (v) => CHANNELS.some((ch) => states[ch] === v);
  return {
    user: any("suspicious") ? "suspicious" : any("genuine") ? "genuine" : undefined,
    token: risk === "suspicious" || any("suspicious") ? "suspicious" : risk,
  };
}

module.exports = { CHANNELS, settled, combine };
