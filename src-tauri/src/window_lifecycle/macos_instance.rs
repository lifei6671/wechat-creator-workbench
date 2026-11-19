use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::ErrorKind,
    os::unix::net::{UnixListener, UnixStream},
    path::Path,
};
use tauri::{
    AppHandle, Manager, Wry,
    plugin::{Builder, TauriPlugin},
};

pub fn macos_instance() -> TauriPlugin<Wry> {
    Builder::<Wry, ()>::new("workspace-instance")
        .setup(|app, _| {
            let data = app.path().app_local_data_dir()?;
            fs::create_dir_all(&data)?;
            let startup_lock = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(data.join("instance-startup.lock"))?;
            // Serialize the socket check and bind before initializing the workbench.
            startup_lock.lock()?;
            let digest = format!("{:x}", Sha256::digest(data.as_os_str().as_encoded_bytes()));
            // Use the same profile identity for Finder and command-line launches.
            let socket = Path::new("/tmp").join(format!("workbench-{}.sock", &digest[..24]));
            match UnixStream::connect(&socket) {
                Ok(_) => std::process::exit(0),
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
                    fs::remove_file(&socket)?
                }
                Err(error) => return Err(error.into()),
            }
            let listener = UnixListener::bind(socket)?;
            listener.set_nonblocking(true)?;
            drop(startup_lock);

            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = accept_reopen_requests(listener, app).await {
                    eprintln!("Could not listen for repeated workspace launches: {error}");
                }
            });
            Ok(())
        })
        .build()
}

async fn accept_reopen_requests(listener: UnixListener, app: AppHandle) -> tauri::Result<()> {
    let listener = tokio::net::UnixListener::from_std(listener)?;
    loop {
        listener.accept().await?;
        let handle = app.clone();
        app.run_on_main_thread(move || super::restore_window(&handle))?;
    }
}
