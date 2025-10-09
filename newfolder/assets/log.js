async function loadLog() {
  const container = document.getElementById("log-entries");

  try {
    const response = await fetch("log.json");
    const data = await response.json();

    data.forEach(entry => {
      const div = document.createElement("div");
      div.className = "log-entry";

      div.innerHTML = `
        <h2>${entry.title}</h2>
        <div class="date">${entry.date}</div>
        <p>${entry.content}</p>
      `;

      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = "<p>Error loading log entries.</p>";
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadLog);
