async function loadStructures() {
  const container = document.getElementById("structure-list");

  try {
    const res = await fetch("../data/future-structures.json");
    const structures = await res.json();

    structures.forEach(s => {
      const div = document.createElement("div");
      div.className = "structure-item";
      div.innerHTML = `<h2>${s.title}</h2><p>${s.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading future structures info.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadStructures);
