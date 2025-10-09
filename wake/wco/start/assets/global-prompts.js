const localPrompts = [
  "Document overlooked issues in your neighborhood or city.",
  "Mirror local civic entries ignored by official channels.",
  "Track municipal patterns that may reflect wider trends."
];

const culturalPrompts = [
  "Identify songs, films, or memes that reflect civic distortions.",
  "Analyze cultural shifts invisible in official narratives.",
  "Document demographic or cultural patterns in your area."
];

const institutionalPrompts = [
  "Record government inaction locally and compare globally.",
  "Propose interventions observed abroad but missing at home.",
  "Examine binational or transnational civic interactions."
];

const reflectivePrompts = [
  "Describe personal experiences that connect to civic silence.",
  "Reflect on how your story adds continuity to the civic record.",
  "Frame observations so future participants can understand context."
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
  populateList("local-prompts", localPrompts);
  populateList("cultural-prompts", culturalPrompts);
  populateList("institutional-prompts", institutionalPrompts);
  populateList("reflective-prompts", reflectivePrompts);
});
