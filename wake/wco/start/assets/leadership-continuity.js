async function loadLeadership() {
  const container = document.getElementById("leadership-list");

  try {
    const res = await fetch("../data/leadership-continuity.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "leadership-item";
      div.innerHTML = `<h2>${i.title}</h2><p>${i.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading leadership content.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadLeadership);
