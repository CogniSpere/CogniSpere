const roles = [
  "Initiator – Start a civic entry or thread.",
  "Mirror – Republish or amplify others' contributions.",
  "Connector – Link local cases to global patterns.",
  "Responder – Add context, ask questions, or engage.",
  "Observer – Witness quietly, maintain presence.",
  "Architect – Create templates or structures for others.",
  "Catalyst – Spread entries through media or networks.",
  "Guardian – Ensure ledger integrity and record-keeping."
];

const prompts = [
  "Document an overlooked issue in your town.",
  "Mirror a civic entry that was ignored elsewhere.",
  "Connect a local pattern to a national or global trend.",
  "Submit a reflection on a cultural signal (song, meme, film).",
  "Create a mini-node and invite others to participate."
];

const tools = [
  "Node Starter Template",
  "Submission Framework",
  "Ledger Entry Template",
  "Tagging Convention Guide",
  "Interactive Civic Form"
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
  populateList("roles", roles);
  populateList("prompts", prompts);
  populateList("tools", tools);
});
