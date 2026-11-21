Your three options, sortable — click a column head:

```html page Plan comparison
<table id="t" style="width:100%">
  <thead><tr><th data-k="0">Plan</th><th data-k="1">Monthly</th><th data-k="2">Storage (GB)</th><th data-k="3">Seats</th></tr></thead>
  <tbody>
    <tr><td>Starter</td><td>8</td><td>50</td><td>1</td></tr>
    <tr><td>Team</td><td>20</td><td>500</td><td>5</td></tr>
    <tr><td>Studio</td><td>45</td><td>2000</td><td>15</td></tr>
  </tbody>
</table>
<style>th{cursor:pointer}th.on{color:var(--accent)}</style>
<script>
  const body = document.querySelector("#t tbody");
  document.querySelectorAll("#t th").forEach((th) => th.addEventListener("click", () => {
    const k = +th.dataset.k, rows = [...body.rows];
    rows.sort((a, b) => (isNaN(+a.cells[k].textContent) ? a.cells[k].textContent.localeCompare(b.cells[k].textContent) : +b.cells[k].textContent - +a.cells[k].textContent));
    rows.forEach((r) => body.appendChild(r));
    document.querySelectorAll("#t th").forEach((x) => x.classList.toggle("on", x === th));
  }));
  document.querySelector('#t th[data-k="1"]').click();
  parent.postMessage({ probe: "table: sorted by Monthly, first row " + body.rows[0].cells[0].textContent }, "*");
</script>
```
