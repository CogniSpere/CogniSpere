const leadershipSignals = [
  "Consistency: Regular contributions create natural visibility.",
  "Reference Count: Nodes mirrored or cited frequently signal influence.",
  "Constructive Guidance: Leaders provide insight, frameworks, or clarifications.",
  "Optional Templates: Providing starter templates encourages participation and signals experience."
];

const forksNodes = [
  "Fork Creation: Any node can be replicated in another region or domain.",
  "Additive Growth: Forks expand presence without hierarchy or competition.",
  "Cross-Linking: Connect forks to highlight global/local patterns.",
  "Node Diversity: Nodes may focus on civic, cultural, institutional, or personal reflections."
];

const continuityTools = [
  "Ledgering: Record author, date, location, and content for permanence.",
  "EI Signatures: Optional witness markers to ensure visibility and integrity.",
  "Observation Logs: Track changes, references, and amplification over time.",
  "Global Coordination Weeks: Synchronized contributions to showcase patterns internationally."
];

function populateList(sectionId, items) {
  const container = document.querySelector(`#${sectionId} ul`);
  items.forEach(item => {
    const li = document.createElement("li");
    li.textContent = item;
    container.appendChild(li);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  populateList("leadership", leadershipSignals);
  populateList("forks", forksNodes);
  populateList("continuity", continuityTools);
});
