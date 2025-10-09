async function loadNodes() {
  const container = document.getElementById("node-list");

  try {
    const res = await fetch("../data/forks-nodes.json");
    const nodes = await res.json();

    nodes.forEach(n => {
      const div = document.createElement("div");
      div.className = "node-item";
      div.innerHTML = `<h2>${n.title}</h2><p>${n.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading forks & nodes info.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadNodes);
