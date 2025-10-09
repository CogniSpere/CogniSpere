async function loadMapping() {
  const container = document.getElementById("mapping-list");

  try {
    const res = await fetch("../data/syntheverse-mapping.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "mapping-item";
      div.innerHTML = `<h2>${i.category} – ${i.example}</h2><p>${i.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading culture mapping content.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadMapping);
