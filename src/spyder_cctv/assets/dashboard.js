const cards = new Map();
const message = document.querySelector('#message');
async function control(id, action) {
  try {
    const response = await fetch(`/api/cameras/${id}/${action}`, {
      method: 'POST', headers: { 'X-Spyder-Control': '1' }
    });
    const result = await response.json();
    message.textContent = response.ok ? '' : result.error;
  } catch { message.textContent = 'Cannot reach the camera server.'; }
}
async function refresh() {
  try {
    const response = await fetch('/api/cameras');
    if (!response.ok) throw new Error('Status failed');
    const cameras = await response.json();
    if (cameras.length === 0) message.textContent = 'No cameras configured. Edit config and restart.';
    for (const camera of cameras) {
      if (!cards.has(camera.id)) {
        const card = document.createElement('article');
        const title = document.createElement('h2');
        title.textContent = camera.id;
        const image = document.createElement('img');
        image.alt = `Live view: ${camera.id}`;
        const status = document.createElement('pre');
        card.append(title, image, status);
        for (const action of ['start', 'stop']) {
          const button = document.createElement('button');
          button.textContent = action === 'start' ? 'Start' : 'Stop';
          button.onclick = () => control(camera.id, action);
          card.append(button);
        }
        document.querySelector('#cameras').append(card);
        cards.set(camera.id, { image, status });
      }
      const { image, status } = cards.get(camera.id);
      status.textContent = JSON.stringify(camera, null, 2);
      if (camera.state === 'running') {
        image.hidden = false;
        image.src = `/api/cameras/${camera.id}/frame?t=${Date.now()}`;
      } else { image.hidden = true; image.removeAttribute('src'); }
    }
  } catch { message.textContent = 'Cannot reach the camera server.'; }
  finally { setTimeout(refresh, 500); }
}
refresh();
