async function loadMap() {
  const container = document.getElementById("map-container");

  try {
    const res = await fetch("../data/map.json");
    const nodes = await res.json();

    nodes.forEach(node => {
      const div = document.createElement("div");
      div.className = "node";

      div.innerHTML = `
        <div class="title">${node.title}</div>
        <div class="level">${node.level}</div>
      `;

      div.addEventListener("click", () => {
        alert(`Node: ${node.title}\nLevel: ${node.level}\nDescription: ${node.description}`);
      });

      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading map data.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadMap);
