use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::Path};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("usage: widgetboard-minisign-verifier <tauri-base64-public-key> <signature-file> <installer-file>".into());
    }
    let public_key_text = String::from_utf8(STANDARD.decode(&args[0])?)?;
    let public_key = PublicKey::decode(&public_key_text)?;
    let signature_text = fs::read_to_string(&args[1])?;
    let signature_text = String::from_utf8(STANDARD.decode(signature_text.trim())?)?;
    let signature = Signature::decode(&signature_text)?;
    let installer = fs::read(Path::new(&args[2]))?;
    public_key.verify(&installer, &signature, true)?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Tauri updater signature verification failed: {error}");
        std::process::exit(1);
    }
}
