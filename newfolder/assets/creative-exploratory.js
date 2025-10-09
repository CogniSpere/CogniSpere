async function loadExploratory() {
  const container = document.getElementById("exploratory-list");

  try {
    const res = await fetch("../data/creative-exploratory.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "exploratory-item";
      div.innerHTML = `<h2>${i.title}</h2><p>${i.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading creative exploratory content.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadExploratory);
