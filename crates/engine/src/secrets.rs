use std::collections::HashMap;
use std::sync::Mutex;

use crate::model::ConnectionId;

const KEYCHAIN_SERVICE: &str = "dev.databot.app";

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SecretError(pub String);

pub trait SecretStore: Send + Sync {
    fn get(&self, id: ConnectionId) -> Result<Option<String>, SecretError>;
    fn set(&self, id: ConnectionId, password: &str) -> Result<(), SecretError>;
    fn delete(&self, id: ConnectionId) -> Result<(), SecretError>;
}

#[derive(Debug, Default)]
pub struct KeyringSecrets;

impl KeyringSecrets {
    fn entry(id: ConnectionId) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(KEYCHAIN_SERVICE, &format!("connection:{}", id.0))
            .map_err(|e| SecretError(e.to_string()))
    }
}

impl SecretStore for KeyringSecrets {
    fn get(&self, id: ConnectionId) -> Result<Option<String>, SecretError> {
        match Self::entry(id)?.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError(e.to_string())),
        }
    }

    fn set(&self, id: ConnectionId, password: &str) -> Result<(), SecretError> {
        Self::entry(id)?
            .set_password(password)
            .map_err(|e| SecretError(e.to_string()))
    }

    fn delete(&self, id: ConnectionId) -> Result<(), SecretError> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError(e.to_string())),
        }
    }
}

#[derive(Debug, Default)]
pub struct MemorySecrets(Mutex<HashMap<ConnectionId, String>>);

impl SecretStore for MemorySecrets {
    fn get(&self, id: ConnectionId) -> Result<Option<String>, SecretError> {
        Ok(self.0.lock().unwrap().get(&id).cloned())
    }

    fn set(&self, id: ConnectionId, password: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap().insert(id, password.to_owned());
        Ok(())
    }

    fn delete(&self, id: ConnectionId) -> Result<(), SecretError> {
        self.0.lock().unwrap().remove(&id);
        Ok(())
    }
}
