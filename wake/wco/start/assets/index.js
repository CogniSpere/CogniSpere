const modules = [
  {title: "1. What is the WCO?", desc: "Introduction, neutral commons, open invitation.", url: "wco-overview.html"},
  {title: "2. How to Start Your Node", desc: "Practical guide for formats, tags, and mirroring.", url: "start-node.html"},
  {title: "3. Roles & Archetypes", desc: "Initiator, Mirror, Connector, Observer, etc.", url: "roles.html"},
  {title: "4. FAQ & Misconceptions", desc: "Clarifies common misunderstandings about WCO.", url: "faq-misconceptions.html"},
  {title: "5.  (*Mini temp*) Civic Prompts", desc: "Local-focused prompts for engagement.", url: "prompt-library.html"},
  {title: "6.  (*Mini temp*) Cultural Prompts", desc: "Music, media, memes as civic signals.", url: "prompt-library.html"},
  {title: "7.  (*Mini temp*) Institutional Prompts", desc: "Government, policy, and civic failure insights.", url: "prompt-library.html"},
  {title: "8.  (*Mini temp*) Reflective Prompts", desc: "Personal experience as civic mirror.", url: "prompt-library.html"},
  {title: "9.  Global Prompts", desc: "Cross-border civic parallels.", url: "global-prompts.html"},
  {title: "10. Forks & Nodes", desc: "Multiplying presence without hierarchy.", url: "forks-nodes.html"},
  {title: "11. Ledger & Signatures", desc: "Preserving trails via EI signatures and public ledgers.", url: "ledger-signatures.html"},
  {title: "12. Future Structures", desc: "Optional templates, federations, and archives.", url: "future-structures.html"},
  {title: "13. Leadership & Continuity", desc: "Emergent leadership through visibility.", url: "leadership-continuity.html"},
  {title: "14. Collective Actions", desc: "Synchronized submissions and global observation weeks.", url: "collective-actions.html"},
  {title: "15. (*Mini temp*) Border Case Study", desc: "Nogales/Menlo Park letters for binational civic framing.", url: "case-studies.html"},
  {title: "16. (*Mini temp*) Music Suppression Case Study", desc: "Song parallels logged as neutral evidence.", url: "case-studies.html"},
  {title: "17. (*Mini temp*) Media Silence Case Study", desc: "Local media collapse and ignored records.", url: "case-studies.html"},
  {title: "18. (*Mini temp*) Fictional Example Walkthrough", desc: "Composite city scenario blending multiple elements.", url: "case-studies.html"},
  {title: "19. Fictional Example Walkthrough", desc: "Composite city scenario blending multiple elements.", url: "fictional-walkthrough.html"},
  {title: "20. AI/EI-verse Culture Mapping", desc: "Music, film, and AI flows as civic signals.", url: "syntheverse-mapping.html"},
  {title: "21. Outside-the-Box Scenarios", desc: "Creative exercises for unconventional WCO nodes.", url: "outside-box-scenarios.html"},
  {title: "22. Creative & Exploratory Layer", desc: "Persona archetypes, cultural mapping, and “what if” scenarios for outside-the-box civic thinking.", url: "creative-exploratory.html"},
  {title: "23. WCO Leadership, Continuity, & Forks", desc: "Learn how leadership naturally emerges, and how forks/nodes can multiply civic visibility while maintaining a flat, neutral structure.", url: "leadership-nodes.html"},
  {title: "24. Forks, Nodes & Ledger Strategies", desc: "Guidance on multiplying WCO presence, mirroring entries, and ensuring civic continuity through ledger practices.", url: "nodes-ledger.html"},
  {title: "25. Civic Tools & Templates", desc: "Starter frameworks for submissions, ledgering, and nodes.", url: "civic-tools-templates.html"}
];

const container = document.getElementById("modules-list");

modules.forEach(m => {
  const div = document.createElement("div");
  div.className = "module-item";
  div.innerHTML = `<a href="${m.url}">${m.title}</a><p>${m.desc}</p>`;
  container.appendChild(div);
});
