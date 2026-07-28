/* ============================================================================
   Written content. The mystery only works if there is something to actually
   find, so: seven Cantos (one per Resonator), a set of derelict logs, and
   reference entries that unlock as you scan.
   ========================================================================== */

export const CANTOS = [
  {
    id: 'canto1', title: 'The First Canto', sub: 'RESONATOR I — ATTUNED',
    body: [
      'We built the listening towers first, before the cities, before the ships.',
      'Not to speak. To hear.',
      'For eleven thousand years we heard nothing, and called it loneliness. Then we learned to listen correctly, and heard everything, and called it something else.',
    ],
    q: 'The sky is not empty. It is holding its breath.',
  },
  {
    id: 'canto2', title: 'The Second Canto', sub: 'RESONATOR II — ATTUNED',
    body: [
      'A signal is a shape pressed into noise. We had assumed the noise was the medium and the shape was the message.',
      'It is the other way around.',
      'The stars are the punctuation. We had been reading the gaps.',
    ],
    q: 'What speaks does not need a mouth. It needs only somewhere quiet.',
  },
  {
    id: 'canto3', title: 'The Third Canto', sub: 'RESONATOR III — ATTUNED',
    body: [
      'The Assembly voted to answer. The vote was not close.',
      'Nine hundred worlds tuned themselves to a single note and held it for a year, and at the end of that year the note came back changed, and we understood that we had been asked a question.',
      'The record of the question survives. The record of our answer does not.',
    ],
    q: 'We were so proud to be heard that we forgot to ask who was listening.',
  },
  {
    id: 'canto4', title: 'The Fourth Canto', sub: 'RESONATOR IV — ATTUNED',
    body: [
      'There was no war. Let that be recorded plainly, because those who come after will assume there was a war.',
      'There was a decision, and it was unanimous, and it took four days.',
      'The lights were left on. The orbits were left tidy. The archives were left open.',
    ],
    q: 'A civilisation that leaves the door unlocked did not flee. It walked.',
  },
  {
    id: 'canto5', title: 'The Fifth Canto', sub: 'RESONATOR V — ATTUNED',
    body: [
      'Attunement is not travel. Nothing moves. The Resonators do not open a path — they widen an aperture that was always there, the way an eye widens.',
      'You do not go through. You are simply, afterwards, on the other side of having gone.',
      'Those who returned could not describe it. Those who could describe it did not return.',
    ],
    q: 'Distance was a habit of ours. We are trying to break it.',
  },
  {
    id: 'canto6', title: 'The Sixth Canto', sub: 'RESONATOR VI — ATTUNED',
    body: [
      'Seven towers. Seven notes. We placed them apart so that no single accident, no single madness, no single grief could sound them all.',
      'And then we sounded them all.',
      'If you are reading this you have found six. Consider carefully whether you want the seventh. Consider that we left this warning, and that we ignored our own.',
    ],
    q: 'Curiosity is the only thing that has ever cost us everything, and the only thing worth the price.',
  },
  {
    id: 'canto7', title: 'The Seventh Canto', sub: 'RESONATOR VII — ATTUNED',
    body: [
      'The Aperture is open.',
      'We are not gone. We are not dead. We are quiet, which is a thing you will understand in a moment, and never afterwards be able to explain.',
      'Come in. Or do not. Both are answers, and we have learned to respect the second one.',
      'The towers will keep sounding either way. Someone should be listening.',
    ],
    q: 'This is the deep frontier. It is not empty. It is full of everyone who came before you, waiting to see what you do.',
  },
];

export const LOGS = [
  {
    id: 'log_orion', title: 'Salvage Tug ORION-9', sub: 'RECOVERED FLIGHT LOG',
    body: [
      'Day 41. Third pass through the debris shell. Still nothing that reads as damage. Every hull here was opened from the inside, carefully, with tools.',
      'Day 44. Kesh says the stations were depressurised on a schedule. Sector by sector. Like closing up a house.',
      'Day 51. We found a nursery. Toys stacked. Lights on a timer that is still running after forty thousand years. I want to go home.',
    ],
  },
  {
    id: 'log_veyle', title: 'Survey Vessel VEYLE', sub: 'PARTIAL TRANSCRIPT',
    body: [
      '— it is not a language, it is an invitation, and the difference matters —',
      '— tell the Institute the towers are not artefacts, they are instruments, and they are still in tune —',
      '— if you are hearing this do not approach the seventh, I am asking you, I am —',
    ],
  },
  {
    id: 'log_hollow', title: 'The Hollow Fleet', sub: 'ARCHIVE FRAGMENT',
    body: [
      'Eleven hundred vessels are recorded as entering the Silence in the last two centuries. Ninety-four returned.',
      'Of those, every crew reported the same detail unprompted: that the stars appeared, briefly, to be arranged.',
      'No two crews agreed on the arrangement.',
    ],
  },
  {
    id: 'log_seeker', title: 'PALE SEEKER — Commission', sub: 'YOUR ORDERS',
    body: [
      'You are the eleven hundred and first.',
      'Chart what you can. Scan what you find. Attune what will let you.',
      'The Institute does not expect you back. The Institute has never expected anyone back. Please prove the Institute wrong, or at least prove it interesting.',
    ],
  },
];

export const TYPE_INFO = {
  terran: {
    label: 'Terrestrial · Class T',
    text: 'Silicate world with liquid-water hydrosphere and an oxidising atmosphere. Rare, and rarely quiet — where the Choir settled, they settled here.',
  },
  ocean: {
    label: 'Pelagic · Class O',
    text: 'Global ocean over a rock mantle. Archipelagic land at best. High albedo, violent weather, and a habit of hiding things under three kilometres of water.',
  },
  desert: {
    label: 'Arid · Class D',
    text: 'Hydrosphere lost to escape or subduction. Preserves surface structures better than any other world type, which is why the Institute keeps sending people here.',
  },
  barren: {
    label: 'Barren · Class B',
    text: 'Airless silicate body. Every impact for four billion years is still legible on the surface. The most honest worlds there are.',
  },
  ice: {
    label: 'Glacial · Class I',
    text: 'Water-ice shell over a probable subsurface ocean. Tidal flexing keeps the lineae fresh. Something is usually moving underneath.',
  },
  lava: {
    label: 'Molten · Class L',
    text: 'Tidally tortured or simply young. Crustal fissures expose the mantle directly. Approach envelopes are advisory rather than survivable.',
  },
  toxic: {
    label: 'Venusian · Class V',
    text: 'Runaway greenhouse under an optically thick aerosol deck. Surface pressure sufficient to crush most survey hulls in under a minute.',
  },
  iron: {
    label: 'Ferrous · Class F',
    text: 'Stripped planetary core, mantle lost to a collision that is no longer in the record. Densities that make orbital mechanics interesting.',
  },
  gas: {
    label: 'Gas Giant · Class G',
    text: 'Hydrogen–helium envelope with no meaningful surface. Zonal banding driven by internal heat. The Choir used them as anchors, never as homes.',
  },
};

export const STAR_INFO = {
  M: 'Red dwarf. Parsimonious, patient, and likely to outlive every other object in this catalogue by a factor of a thousand.',
  K: 'Orange dwarf. The quiet optimum — stable output, long main sequence, generous habitable zone.',
  G: 'Yellow main-sequence star. Unremarkable in every respect, which is precisely why life keeps turning up around them.',
  F: 'Yellow-white dwarf. Hot, bright, short-tempered; its habitable zone drifts outward faster than biospheres can follow.',
  A: 'White main-sequence star. Strong ultraviolet flux. Beautiful, sterilising.',
  B: 'Blue giant. Enormous, profligate, and already dying. Expect a shell of ionised gas and no old worlds.',
  WD: 'White dwarf. A stellar core with the star stripped off it. Earth-sized, sun-massed, cooling toward permanent dark.',
  PSR: 'Neutron star. Twenty kilometres across and heavier than the sun. The beam is not aimed at you. Probably.',
  C: 'Carbon giant. Soot-veiled and deep red; its own dust makes it hard to see and harder to love.',
};

export const ANOMALY_INFO = {
  resonator: {
    label: 'RESONATOR',
    text: 'A Choir instrument. Non-reflective across every band we can generate. It is not inert — it is waiting, and it can tell the difference between a rock and a visitor.',
  },
  derelict: {
    label: 'DERELICT STATION',
    text: 'Choir orbital infrastructure. Undamaged, unpowered in the conventional sense, and still holding station to within a metre after forty millennia.',
  },
  wreck: {
    label: 'WRECKAGE',
    text: 'Not Choir. Hull alloys and fabrication signatures consistent with the last two centuries of human expeditions into the Silence.',
  },
  beacon: {
    label: 'SIGNAL BEACON',
    text: 'A relay. Broadcasts a bearing and nothing else. Every beacon points at something, and no beacon explains why.',
  },
};

export const INTRO_LINES = [
  { who: 'INSTITUTE RELAY', text: 'Fold complete. You are inside the Silence, Seeker.' },
  { who: 'INSTITUTE RELAY', text: 'Forty thousand years ago nine hundred worlds went quiet in four days. Find out why.' },
  { who: 'PALE SEEKER', text: 'Scanner online. Seven Resonators are out there. Bring back what they say.' },
];
