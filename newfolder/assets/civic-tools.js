async function loadTools() {
  const container = document.getElementById("tools-list");

  try {
    const res = await fetch("../data/civic-tools.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "tool-item";
      div.innerHTML = `<h2>${i.tool}</h2><p>${i.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading tools content.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadTools);
