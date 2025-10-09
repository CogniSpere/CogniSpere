async function loadNodes() {
  const container = document.getElementById("nodes-list");

  try {
    const res = await fetch("../data/nodes-ledger.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "node-item";
      div.innerHTML = `<h2>${i.title}</h2><p>${i.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading nodes and ledger content.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadNodes);
