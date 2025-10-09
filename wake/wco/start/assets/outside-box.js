async function loadScenarios() {
  const container = document.getElementById("scenario-list");

  try {
    const res = await fetch("../data/outside-box.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "scenario-item";
      div.innerHTML = `<h2>${i.scenario}</h2><p>${i.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading scenarios content.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadScenarios);
