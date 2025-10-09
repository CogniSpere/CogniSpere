async function loadWalkthrough() {
  const container = document.getElementById("walkthrough-list");

  try {
    const res = await fetch("../data/fictional-walkthrough.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "walkthrough-item";
      div.innerHTML = `<h2>${i.title}</h2><p>${i.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading fictional walkthrough content.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadWalkthrough);
