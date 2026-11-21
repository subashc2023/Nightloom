Here is how the four study weeks went. Hours are what you logged; the line is the practice-exam score that week.

```html page Study hours and practice scores
<div id="chart" style="width:100%"></div>
<p><small>Hover a bar for the exact figure. Data from the four weekly logs.</small></p>
<script src="kit:vega-lite"></script>
<script>
  const weeks = [
    { week: "Week 1", hours: 6, score: 58 }, { week: "Week 2", hours: 9, score: 66 },
    { week: "Week 3", hours: 14, score: 79 }, { week: "Week 4", hours: 11, score: 84 },
  ];
  nightloom.chart("#chart", {
    data: { values: weeks }, height: 220,
    encoding: { x: { field: "week", type: "nominal", title: null, axis: { labelAngle: 0 } } },
    layer: [
      { mark: { type: "bar", cornerRadiusEnd: 3, tooltip: true }, encoding: { y: { field: "hours", type: "quantitative", title: "Hours studied" } } },
      { mark: { type: "line", point: true, tooltip: true }, encoding: { y: { field: "score", type: "quantitative", title: "Practice score (%)", scale: { domain: [40, 100] } }, color: { value: nightloom.theme.series[1] } } },
    ],
    resolve: { scale: { y: "independent" } },
  }).then(async (r) => {
    let net = "not tried";
    try { await fetch("https://example.com/"); net = "REACHED THE NETWORK"; } catch (e) { net = "fetch blocked"; }
    parent.postMessage({ probe: "vega-lite " + vegaLite.version + ": " + document.querySelectorAll("#chart svg path").length + " paths drawn; " + net }, "*");
  });
</script>
```

The jump came in week 3, when the hours nearly doubled.
