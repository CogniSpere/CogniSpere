async function loadCaseStudy() {
  const container = document.getElementById("case-list");

  try {
    const res = await fetch("../data/case-study.json");
    const cases = await res.json();

    cases.forEach(c => {
      const div = document.createElement("div");
      div.className = "case-item";
      div.innerHTML = `<h2>${c.title}</h2><p>${c.description}</p>`;
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading case study.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadCaseStudy);
