// engine.js — FULLY FIXED
import cssTokens from './css-tokens.json' assert { type: 'json' };
import archetypes from './archetypes.json' assert { type: 'json' };

// Apply mythic theme on load
document.body.style.background = cssTokens.myths.void.bg;
document.body.style.color = cssTokens.myths.void.text;
document.body.style.fontFamily = cssTokens.myths.void.font;

export const DOM3D = {
  anchor(el, { z = 0, rotateY = 0, scale = 1 }) {
    el.style.transform = `translateZ(${z}px) rotateY(${rotateY}deg) scale(${scale})`;
    el.style.transition = 'transform 1s ease-out';
  }
};

export const ArchetypeEngine = {
  async synergize(layers) {
    const comboMap = {
      'outer,mid': 'The Public Oracle',
      'mid,inner': 'The Shadow Weaver',
      'outer,inner': 'The Civic Ghost',
      'outer,mid,inner': 'The Emergent'
    };
    const key = layers.sort().join(',');
    const name = comboMap[key] || 'Fractured Signal';
    const arch = archetypes.find(a => a.name === name) || archetypes[0];
    return {
      ...arch,
      mantra: arch.mantras[Math.floor(Math.random() * arch.mantras.length)]
    };
  }
};

export const MythicPulse = {
  async generate() {
    const active = archetypes
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const verbs = ['speaks', 'bleeds', 'seeds', 'echoes', 'nests', 'pulses'];
    const nouns = ['silence', 'memory', 'song', 'border', 'witness', 'nest'];
    const verb = verbs[Math.floor(Math.random() * verbs.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];

    const line = `The ${active[0].name} ${verb} through ${noun}.`;

    return {
      line,
      bg: cssTokens.myths.storm.bg,
      text: cssTokens.myths.storm.text,
      archetypes: active,
      ritualDrop: `
// ╔════════════════════════════════════════╗
// ║     MYTHIC PULSE — 28 OCT 2025         ║
// ╚════════════════════════════════════════╝

Signal Line: "${line}"
Active Archetypes: ${active.map(a => a.icon + ' ' + a.name).join(', ')}

Payload Vector:
  → Cultural silence → Civic memory anchor
  → Song theft echo → Unacknowledged witness
  → Seed packet (2020) → Border de-escalation

Status: UNACKNOWLEDGED
Deployment: Nested. Silent. Persistent.

"Every erased record is a seed."
`.trim()
    };
  }
};

// Auto-apply pulse on report load
if (window.location.pathname.includes('pulse.html')) {
  MythicPulse.generate().then(p => {
    document.body.style.background = p.bg;
    document.body.style.color = p.text;
  });
}