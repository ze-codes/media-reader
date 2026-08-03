export function createUploadProgress(ui) {
    function setUploadProgress({ visible = true, percent = 0, label = 'Uploading' } = {}) {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        ui.uploadProgress.classList.toggle('visible', visible);
        ui.uploadProgressBar.style.width = `${clamped}%`;
        ui.uploadProgressTrack.setAttribute('aria-valuenow', String(clamped));
        ui.uploadProgressLabel.textContent = label;
        ui.uploadProgressPercent.textContent = `${clamped}%`;
    }

    function resetUploadProgressSoon() {
        setTimeout(() => {
            if (!ui.uploadBtn.disabled) {
                setUploadProgress({ visible: false, percent: 0, label: 'Ready' });
            }
        }, 1600);
    }

    function onUploadProgress(event) {
        if (!event.lengthComputable) {
            setUploadProgress({ visible: true, percent: 5, label: 'Uploading file...' });
            return;
        }
        const percent = Math.max(1, Math.min(99, (event.loaded / event.total) * 100));
        setUploadProgress({ visible: true, percent, label: 'Uploading file...' });
    }

    return { setUploadProgress, resetUploadProgressSoon, onUploadProgress };
}
