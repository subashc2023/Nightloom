The three results worth memorising, side by side:

```html page Formula sheet: maximum likelihood
<table style="width:100%">
  <tr><th>Model</th><th>Log-likelihood</th><th>Estimator</th></tr>
  <tr><td>Exponential($\lambda$)</td><td>$\ell(\lambda) = n\ln\lambda - \lambda\sum x_i$</td><td>$\hat\lambda = \dfrac{n}{\sum x_i}$</td></tr>
  <tr><td>Normal($\mu$, $\sigma^2$)</td><td>$\ell(\mu) = -\dfrac{1}{2\sigma^2}\sum (x_i-\mu)^2 + c$</td><td>$\hat\mu = \bar{x}$</td></tr>
  <tr><td>Uniform($0$, $\theta$)</td><td>$\ell(\theta) = -n\ln\theta,\ \theta \ge x_{(n)}$</td><td>$\hat\theta = x_{(n)}$</td></tr>
</table>
$$\hat\theta_{\text{MLE}} = \arg\max_{\theta}\ \sum_{i=1}^{n} \ln f(x_i \mid \theta)$$
<script src="kit:katex"></script>
<script>
  addEventListener("load", async () => {
    await document.fonts.ready;
    let net = "not tried";
    try { await fetch("https://example.com/"); net = "REACHED THE NETWORK"; } catch (e) { net = "fetch blocked"; }
    const fonts = [...document.fonts].filter((f) => f.status === "loaded").length;
    parent.postMessage({ probe: "katex " + katex.version + ": " + document.querySelectorAll(".katex").length + " formulas typeset, " + fonts + " fonts loaded from data:; " + net }, "*");
  });
</script>
```

Only the uniform one is not found by differentiating.
