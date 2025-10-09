async function loadPrompts() {
  const container = document.getElementById("prompt-list");

  try {
    const res = await fetch("../data/prompt-library.json");
    const items = await res.json();

    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "prompt-item";
      div.innerHTML = `<h2>${i.category}</h2><ul>${i.prompts.map(p => `<li>${p}</li>`).join('')}</ul>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading prompts.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadPrompts);
