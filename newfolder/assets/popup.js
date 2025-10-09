// Save clipboard data as file (manual filename)
function fallbackSave(data, filename) {
  const blob = new Blob([data], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Manual save button event
document.getElementById("saveBtn").addEventListener("click", async () => {
  const filename = document.getElementById("filename").value || "ei-drop.txt";
  let data;
  try {
    data = await navigator.clipboard.readText();
  } catch (err) {
    console.error("Failed to read clipboard:", err);
    alert("Could not read clipboard data.");
    return;
  }
  fallbackSave(data, filename);
});

// Parse indented text tree
function parseTree(text) {
  const lines = text.split('\n').map(l => l.replace(/\r/g, ''));

  // Helper to clean a line: remove bullets, pipes, and ignore comments
  function cleanLine(line) {
    // Ignore comments
    if (/^\s*(#|\/\/|--|NOTE:)/.test(line)) return null;
    // Remove leading bullets/pipes/stars/dashes
    return line.replace(/^[\s\-\*\|>]+/, '').trim();
  }

  let tree = [];
  let stack = [{children: tree, indent: -1}];

  for (let line of lines) {
    let cleaned = cleanLine(line);
    if (!cleaned) continue; // skip comments and empty lines
    if (!cleaned.trim()) continue;

    const indent = line.match(/^ */)[0].length;
    const name = cleaned;
    const isFolder = name.endsWith('/');

    let node = { name, children: isFolder ? [] : null };

    while (stack.length && indent <= stack[stack.length-1].indent) stack.pop();
    stack[stack.length-1].children.push(node);
    if (isFolder) stack.push({children: node.children, indent});
  }
  return tree;
}

// Render tree as clickable list
function renderTree(tree, basePath='') {
  let html = '';
  for (let node of tree) {
    const path = basePath ? basePath + '/' + node.name.replace(/\/$/, '') : node.name.replace(/\/$/, '');
    if (node.children) {
      html += `<div class="folder">${node.name}</div>`;
      html += renderTree(node.children, path);
    } else {
      html += `<div class="file" data-path="${path}">${node.name}</div>`;
    }
  }
  return html;
}

// Save tree text to chrome storage
function saveTreeText(text) {
  chrome.storage.local.set({directoryTreeText: text});
}

// Load tree text from chrome storage
function loadTreeText(callback) {
  chrome.storage.local.get(['directoryTreeText'], function(result) {
    callback(result.directoryTreeText || '');
  });
}

// On popup load, try to render saved tree
window.onload = function() {
  loadTreeText(function(treeText) {
    if (treeText) {
      document.getElementById('treeInput').value = treeText;
      const tree = parseTree(treeText);
      document.getElementById('tree').innerHTML = renderTree(tree);
    }
  });
};

// Parse & save tree on button click
document.getElementById('parseBtn').onclick = function() {
  const treeText = document.getElementById('treeInput').value;
  saveTreeText(treeText); // Save for next time
  const tree = parseTree(treeText);
  document.getElementById('tree').innerHTML = renderTree(tree);
  document.getElementById('output').textContent = '';
};

// Clear tree from storage and UI
document.getElementById('clearBtn').onclick = function() {
  chrome.storage.local.remove(['directoryTreeText'], function() {
    document.getElementById('treeInput').value = '';
    document.getElementById('tree').innerHTML = '';
    document.getElementById('output').textContent = 'Tree cleared.';
  });
};

// Handle file click/save
document.getElementById('tree').onclick = async function(e) {
  if (!e.target.classList.contains('file')) return;
  const filePath = e.target.getAttribute('data-path');
  const clipboardText = await navigator.clipboard.readText();
  fallbackSave(clipboardText, filePath);
  document.getElementById('output').textContent = `Saved clipboard to "${filePath}"`;
};