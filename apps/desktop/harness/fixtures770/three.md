The surface, to turn with the mouse:

```html page Likelihood surface
<div id="v" style="height:300px"></div>
<script src="kit:three"></script>
<script>
  const el = document.getElementById("v");
  let note = "three r" + THREE.REVISION + ": ";
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(el.clientWidth, 300); el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, el.clientWidth / 300, 0.1, 100); cam.position.set(4, 3.2, 5);
    const g = new THREE.PlaneGeometry(6, 6, 60, 60); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, 1.6 * Math.exp(-(x * x + z * z) / 3)); }
    g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, new THREE.MeshNormalMaterial({ wireframe: true })));
    const controls = new THREE.OrbitControls(cam, renderer.domElement); controls.target.set(0, 0.5, 0); controls.update();
    renderer.render(scene, cam);
    renderer.setAnimationLoop(() => renderer.render(scene, cam));
    note += "WebGL scene with " + p.count + " vertices";
  } catch (e) { note += "no WebGL here (" + e.message + ")"; el.textContent = note; }
  parent.postMessage({ probe: note }, "*");
</script>
```
