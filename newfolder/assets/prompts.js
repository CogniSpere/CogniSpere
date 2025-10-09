async function loadPrompts() {
  const categoriesContainer = document.getElementById("prompt-categories");
  const listContainer = document.getElementById("prompt-list");

  try {
    const res = await fetch("../data/prompts.json");
    const data = await res.json();

    const categories = Object.keys(data);
    categories.forEach(cat => {
      const btn = document.createElement("div");
      btn.className = "category-btn";
      btn.textContent = cat;
      btn.addEventListener("click", () => showPrompts(cat));
      categoriesContainer.appendChild(btn);
    });

    // load first category by default
    if (categories.length > 0) showPrompts(categories[0]);

    function showPrompts(cat) {
      listContainer.innerHTML = "";
      data[cat].forEach(prompt => {
        const div = document.createElement("div");
        div.className = "prompt-item";
        div.textContent = prompt;
        listContainer.appendChild(div);
      });
    }

  } catch (err) {
    listContainer.innerHTML = "<p>Error loading prompts.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadPrompts);
