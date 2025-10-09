const steps = [
  "Alex identifies a civic issue: a local park scheduled for unexpected redevelopment.",
  "Alex creates a node using the WCO Node Starter Template, tagging it: [WCO + CityName + Date].",
  "The initial submission includes photos, personal observations, and references to local regulations.",
  "Other citizens and community organizations discover the node and mirror it in their own nodes.",
  "Connectors link Alex's node to similar issues nationally and globally, showing patterns of municipal oversight.",
  "During a Global Observation Week, the node is amplified and referenced by international participants.",
  "Ledger entries are created to preserve the timeline and contributions of each participant.",
  "The node remains open-ended, allowing new insights, updates, and reflections to be added continuously."
];

const container = document.querySelector("#steps ol");
steps.forEach(step => {
  const li = document.createElement("li");
  li.textContent = step;
  container.appendChild(li);
});
