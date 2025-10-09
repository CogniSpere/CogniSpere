async function loadLedger() {
  const container = document.getElementById("ledger-list");

  try {
    const res = await fetch("../data/ledger-signatures.json");
    const entries = await res.json();

    entries.forEach(e => {
      const div = document.createElement("div");
      div.className = "ledger-item";
      div.innerHTML = `<h2>${e.title}</h2><p>${e.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading ledger information.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadLedger);
