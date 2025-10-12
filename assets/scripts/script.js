// script.js - Core loader for Cerebrolusion modular site

document.addEventListener("DOMContentLoaded", () => {
  const nav = document.getElementById("nav-links");

  const pages = [
    { title: "Welcome", file: "/pages/page1.html" },
    { title: "What’s New", file: "/pages/page2.html" },
    { title: "Minds at Play", file: "/pages/page3.html" },
    { title: "Echoes of Thought", file: "/pages/page4.html" }
  ];

  pages.forEach((p) => {
    const link = document.createElement("a");
    link.href = p.file;
    link.target = "main-frame";
    link.textContent = p.title;
    nav.appendChild(link);
  });
});