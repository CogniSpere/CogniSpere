async function loadNav() {
  const res = await fetch("data/pages.json");
  const pages = await res.json();
  const nav = document.getElementById("nav");

  pages.forEach(page => {
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = page.title;
    link.addEventListener("click", e => {
      e.preventDefault();
      loadPage(page.file);
    });
    nav.appendChild(link);
  });

  // auto-load first page
  if (pages.length > 0) loadPage(pages[0].file);
}

async function loadPage(file) {
  const res = await fetch(`pages/${file}`);
  const html = await res.text();
  document.getElementById("content").innerHTML = html;
}

loadNav();
