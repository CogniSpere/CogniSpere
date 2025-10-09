async function loadCollective() {
  const container = document.getElementById("collective-list");

  try {
    const res = await fetch("../data/collective-actions.json");
    const actions = await res.json();

    actions.forEach(a => {
      const div = document.createElement("div");
      div.className = "collective-item";
      div.innerHTML = `<h2>${a.title}</h2><p>${a.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading collective actions info.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadCollective);
