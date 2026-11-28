fetch("/api/info")
  .then((res) => res.json())
  .then((data) => {
    const el = document.getElementById("status");
    if (el) el.textContent = `${data.name} v${data.version}`;
  });
