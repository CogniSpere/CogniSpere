async function loadPersona() {
  const container = document.getElementById("persona-list");

  try {
    const res = await fetch("../data/persona-archetype.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "persona-item";
      div.innerHTML = `<h2>${i.name} – ${i.role}</h2><p>${i.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading persona content.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadPersona);
