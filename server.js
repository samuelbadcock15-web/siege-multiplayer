function undoDemolishPanel(panel, isRemote = false) {
  if (!panel) return;

  if (panel.userData.isRootBase) {
    statusText.innerText = "ROOT BASE SQUARE CANNOT BE DEMOLISHED!";
    statusText.style.color = "#ff4444";
    setTimeout(() => { statusText.style.color = "#00ff00"; updateStatusUI(); }, 2000);
    return;
  }

  if (panel.userData.panelType === 'ramp' && (panel.userData.rampSegments || 1) > 1) {
    panel.userData.rampSegments -= 1;
    const segs = panel.userData.rampSegments;
    const newLength = RAMP_DIAG * segs;
    panel.userData.rampLength = newLength;

    panel.geometry.dispose();
    panel.geometry = createAlignedRampGeometry(newLength);

    if (!isRemote) {
      socket.emit('shorten_ramp', {
        roomId: currentRoomId,
        id: panel.userData.id,
        rampSegments: segs
      });
    }
    renderPanelHandles(panel);
  } else {
    const idToRemove = panel.userData.id;
    scene.remove(panel);
    const idx = worldPanels.indexOf(panel);
    if (idx !== -1) worldPanels.splice(idx, 1);

    if (activeBasePanel === panel) {
      clearShotgunHandles();
      activeBasePanel = null;
    }

    if (!isRemote) {
      socket.emit('remove_panel', {
        roomId: currentRoomId,
        id: idToRemove
      });
    }

    statusText.innerText = "PANEL DEMOLISHED & UNLOADED!";
    statusText.style.color = "#ff9900";
    setTimeout(() => { statusText.style.color = "#00ff00"; updateStatusUI(); }, 2000);
  }
}

socket.on('opponent_remove_panel', (data) => {
  const p = worldPanels.find(x => x.userData.id === data.id);
  if (p) {
    scene.remove(p);
    const idx = worldPanels.indexOf(p);
    if (idx !== -1) worldPanels.splice(idx, 1);
    if (activeBasePanel === p) {
      clearShotgunHandles();
      activeBasePanel = null;
    }
  }
});

socket.on('opponent_shorten_ramp', (data) => {
  const r = worldPanels.find(p => p.userData.id === data.id);
  if (r) {
    r.userData.rampSegments = data.rampSegments;
    const newLength = RAMP_DIAG * data.rampSegments;
    r.userData.rampLength = newLength;
    r.geometry.dispose();
    r.geometry = createAlignedRampGeometry(newLength);
    renderPanelHandles(r);
  }
});
