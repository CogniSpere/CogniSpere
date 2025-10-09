async function loadRoles() {
  const categoriesContainer = document.getElementById("role-categories");
  const detailsContainer = document.getElementById("role-details");

  try {
    const res = await fetch("../data/roles.json");
    const data = await res.json();

    const roles = Object.keys(data);
    roles.forEach(role => {
      const btn = document.createElement("div");
      btn.className = "role-btn";
      btn.textContent = role;
      btn.addEventListener("click", () => showRole(role));
      categoriesContainer.appendChild(btn);
    });

    if (roles.length > 0) showRole(roles[0]);

    function showRole(role) {
      detailsContainer.innerHTML = "";
      data[role].forEach(detail => {
        const div = document.createElement("div");
        div.className = "role-item";
        div.innerHTML = `<h2>${detail.name}</h2><p>${detail.description}</p>`;
        detailsContainer.appendChild(div);
      });
    }

  } catch (err) {
    detailsContainer.innerHTML = "<p>Error loading roles.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadRoles);
