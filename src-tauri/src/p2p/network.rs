//! Network diagnostics and firewall configuration
//!
//! Provides:
//! - Port availability checking
//! - Firewall rule management with elevated privileges
//! - Network diagnostics for P2P connectivity
//! - Platform-specific firewall configuration (Windows/Linux/macOS)

use std::net::UdpSocket;
use std::process::Command;

/// Sanitize app name for use in shell commands to prevent command injection.
/// Only allows alphanumeric characters, spaces, hyphens, and underscores.
/// Returns sanitized string or error if input is invalid.
fn sanitize_app_name(name: &str) -> Result<String, &'static str> {
    // Reject empty names
    if name.is_empty() {
        return Err("App name cannot be empty");
    }

    // Reject names that are too long (prevent buffer overflow attacks)
    if name.len() > 64 {
        return Err("App name too long (max 64 characters)");
    }

    // Only allow safe characters: alphanumeric, space, hyphen, underscore
    let sanitized: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect();

    // Ensure we got at least some characters
    if sanitized.is_empty() {
        return Err("App name contains no valid characters");
    }

    // Ensure the sanitized version matches the original (no filtering occurred)
    if sanitized != name {
        return Err("App name contains invalid characters");
    }

    Ok(sanitized)
}

/// Result of a firewall configuration attempt
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FirewallResult {
    /// Successfully configured
    Success { message: String },
    /// Needs admin privileges - will prompt for elevation
    NeedsElevation { message: String },
    /// User cancelled the elevation prompt
    Cancelled,
    /// Failed to configure
    Error { message: String },
    /// Already configured
    AlreadyConfigured,
}

/// Network interface info
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NetworkInterface {
    /// Interface name (e.g., "Ethernet", "Wi-Fi", "Radmin VPN")
    pub name: String,
    /// IP address
    pub ip: String,
    /// Whether this looks like a VPN interface
    pub is_vpn: bool,
}

/// Port status info
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PortStatus {
    /// Port number
    pub port: u16,
    /// Whether port is available or working
    pub open: bool,
    /// Status description
    pub status: String,
}

/// Network diagnostics result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NetworkDiagnostics {
    /// Local IP address (primary)
    pub local_ip: Option<String>,
    /// All network interfaces with their IPs
    pub all_interfaces: Vec<NetworkInterface>,
    /// Base UDP discovery port
    pub udp_port: u16,
    /// Base TCP transfer port
    pub tcp_port: u16,
    /// UDP port status (including fallbacks)
    pub udp_status: PortStatus,
    /// TCP port status (including fallbacks)
    pub tcp_status: PortStatus,
    /// UDP port is available/working (for backwards compat)
    pub udp_port_open: bool,
    /// TCP port is available/working (for backwards compat)
    pub tcp_port_open: bool,
    /// Whether Connect is currently enabled
    pub connect_enabled: bool,
    /// Found other peers in network
    pub peers_found: bool,
    /// Firewall likely blocking
    pub firewall_likely_blocking: bool,
    /// Platform-specific recommendations
    pub recommendations: Vec<NetworkRecommendation>,
    /// Whether firewall rules exist
    pub firewall_rules_exist: bool,
}

/// Network recommendation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NetworkRecommendation {
    pub priority: u8,
    pub title: String,
    pub description: String,
    /// Optional action key for UI buttons
    pub action: Option<String>,
    /// Whether this can be auto-fixed
    pub can_auto_fix: bool,
}

/// Check network and diagnose issues
/// `connect_enabled` - whether Stuzhik Connect is currently enabled
pub async fn diagnose_network(discovery_port: u16, connect_enabled: bool) -> NetworkDiagnostics {
    let local_ip = get_local_ip();
    let all_interfaces = get_all_interfaces();
    let firewall_rules_exist = check_firewall_rules_exist("Stuzhik").await;

    // Check UDP port with fallbacks (base, +10, +20, +30)
    let udp_fallbacks = [
        discovery_port,
        discovery_port + 10,
        discovery_port + 20,
        discovery_port + 30,
    ];
    let udp_status = check_port_with_fallbacks(&udp_fallbacks, connect_enabled, true).await;

    // Check TCP port with fallbacks
    let tcp_base = discovery_port + 1;
    let tcp_fallbacks = [tcp_base, tcp_base + 10, tcp_base + 20, tcp_base + 30];
    let tcp_status = check_port_with_fallbacks(&tcp_fallbacks, connect_enabled, false).await;

    let udp_port_open = udp_status.open;
    let tcp_port_open = tcp_status.open;

    let firewall_likely_blocking = !udp_port_open || !tcp_port_open;

    let mut recommendations = Vec::new();

    if firewall_likely_blocking && !firewall_rules_exist {
        recommendations.push(NetworkRecommendation {
            priority: 1,
            title: "firewall_blocking".to_string(),
            description: "firewall_blocking_desc".to_string(),
            action: Some("configure_firewall".to_string()),
            can_auto_fix: true,
        });
    }

    if local_ip.is_none() {
        recommendations.push(NetworkRecommendation {
            priority: 2,
            title: "no_network".to_string(),
            description: "no_network_desc".to_string(),
            action: None,
            can_auto_fix: false,
        });
    }

    // VPN recommendation for internet play
    recommendations.push(NetworkRecommendation {
        priority: 3,
        title: "use_vpn".to_string(),
        description: "use_vpn_desc".to_string(),
        action: None,
        can_auto_fix: false,
    });

    NetworkDiagnostics {
        local_ip,
        all_interfaces,
        udp_port: discovery_port,
        tcp_port: discovery_port + 1,
        udp_status,
        tcp_status,
        udp_port_open,
        tcp_port_open,
        connect_enabled,
        peers_found: false,
        firewall_likely_blocking,
        recommendations,
        firewall_rules_exist,
    }
}

/// Get local IP address (primary, for internet routing)
fn get_local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}

/// Get all network interfaces with their IPs
fn get_all_interfaces() -> Vec<NetworkInterface> {
    let mut interfaces = Vec::new();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Use ipconfig with UTF-8 codepage (65001) to get all interfaces
        // This ensures Cyrillic and other non-ASCII characters are properly decoded
        if let Ok(output) = Command::new("cmd")
            .args(["/c", "chcp 65001 >nul && ipconfig"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            parse_windows_ipconfig(&output_str, &mut interfaces);
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        // Use ip addr on Linux, ifconfig on macOS
        #[cfg(target_os = "linux")]
        let cmd_result = Command::new("ip").args(["addr", "show"]).output();

        #[cfg(target_os = "macos")]
        let cmd_result = Command::new("ifconfig").output();

        if let Ok(output) = cmd_result {
            let output_str = String::from_utf8_lossy(&output.stdout);

            #[cfg(target_os = "linux")]
            parse_linux_ip_addr(&output_str, &mut interfaces);

            #[cfg(target_os = "macos")]
            parse_macos_ifconfig(&output_str, &mut interfaces);
        }
    }

    // Filter out localhost and link-local addresses
    interfaces.retain(|iface| {
        !iface.ip.starts_with("127.")
            && !iface.ip.starts_with("169.254.")
            && !iface.ip.starts_with("fe80:")
    });

    interfaces
}

/// Parse Windows ipconfig output
#[cfg(target_os = "windows")]
fn parse_windows_ipconfig(output: &str, interfaces: &mut Vec<NetworkInterface>) {
    let mut current_name = String::new();

    for line in output.lines() {
        let line = line.trim();

        // Adapter name line (e.g., "Ethernet adapter Radmin VPN:")
        if line.ends_with(':') && !line.contains("IPv") && !line.contains("DNS") {
            // Extract adapter name
            current_name = line
                .trim_end_matches(':')
                .replace("Ethernet adapter ", "")
                .replace("Wireless LAN adapter ", "")
                .replace("Unknown adapter ", "")
                .to_string();
        }

        // IPv4 Address line
        if line.contains("IPv4") && line.contains(':') {
            if let Some(ip) = line.split(':').nth(1) {
                let ip = ip.trim().to_string();
                if !ip.is_empty() {
                    let is_vpn = is_vpn_interface(&current_name);
                    interfaces.push(NetworkInterface {
                        name: current_name.clone(),
                        ip,
                        is_vpn,
                    });
                }
            }
        }
    }
}

/// Parse Linux ip addr output
#[cfg(target_os = "linux")]
fn parse_linux_ip_addr(output: &str, interfaces: &mut Vec<NetworkInterface>) {
    let mut current_name = String::new();

    for line in output.lines() {
        let line = line.trim();

        // Interface line (e.g., "2: eth0: <BROADCAST...")
        if let Some(first_char) = line.chars().next() {
            if first_char.is_ascii_digit() && line.contains(':') {
                if let Some(name_part) = line.split(':').nth(1) {
                    current_name = name_part.trim().split('@').next().unwrap_or("").to_string();
                }
            }
        }

        // inet line (e.g., "inet 192.168.1.5/24")
        if line.starts_with("inet ") && !line.starts_with("inet6") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let ip = parts[1].split('/').next().unwrap_or("").to_string();
                if !ip.is_empty() {
                    let is_vpn = is_vpn_interface(&current_name);
                    interfaces.push(NetworkInterface {
                        name: current_name.clone(),
                        ip,
                        is_vpn,
                    });
                }
            }
        }
    }
}

/// Parse macOS ifconfig output
#[cfg(target_os = "macos")]
fn parse_macos_ifconfig(output: &str, interfaces: &mut Vec<NetworkInterface>) {
    let mut current_name = String::new();

    for line in output.lines() {
        // Interface line (starts without whitespace)
        if !line.starts_with('\t') && !line.starts_with(' ') && line.contains(':') {
            current_name = line.split(':').next().unwrap_or("").to_string();
        }

        // inet line
        let line = line.trim();
        if line.starts_with("inet ") && !line.starts_with("inet6") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let ip = parts[1].to_string();
                if !ip.is_empty() {
                    let is_vpn = is_vpn_interface(&current_name);
                    interfaces.push(NetworkInterface {
                        name: current_name.clone(),
                        ip,
                        is_vpn,
                    });
                }
            }
        }
    }
}

/// Check if interface name looks like a VPN
fn is_vpn_interface(name: &str) -> bool {
    let name_lower = name.to_lowercase();
    name_lower.contains("vpn")
        || name_lower.contains("radmin")
        || name_lower.contains("zerotier")
        || name_lower.contains("tailscale")
        || name_lower.contains("hamachi")
        || name_lower.contains("tun")
        || name_lower.contains("tap")
        || name_lower.contains("wg") // WireGuard
}

/// Check if a port is available (can be bound)
fn check_port_available(port: u16) -> bool {
    // Try UDP bind
    UdpSocket::bind(format!("0.0.0.0:{}", port)).is_ok()
}

/// Check ports with fallbacks and return detailed status
async fn check_port_with_fallbacks(
    ports: &[u16],
    connect_enabled: bool,
    is_udp: bool,
) -> PortStatus {
    let base_port = ports[0];

    for &port in ports {
        // Try to bind
        if check_port_available(port) {
            let status = if port == base_port {
                "Свободен".to_string()
            } else {
                format!("Свободен (резервный: {})", port)
            };
            return PortStatus {
                port,
                open: true,
                status,
            };
        }

        // Port is occupied - check if it's us (when Connect is enabled)
        if connect_enabled {
            let is_ours = if is_udp {
                check_udp_is_our_service(port).await
            } else {
                check_tcp_can_connect(port).await
            };

            if is_ours {
                let status = if port == base_port {
                    "Используется Stuzhik".to_string()
                } else {
                    format!("Используется Stuzhik (резервный: {})", port)
                };
                return PortStatus {
                    port,
                    open: true,
                    status,
                };
            }
        }
    }

    // All ports occupied by other processes
    PortStatus {
        port: base_port,
        open: false,
        status: format!("Все порты заняты ({}, +10, +20, +30)", base_port),
    }
}

/// Check if our UDP discovery service is responding on the port
async fn check_udp_is_our_service(port: u16) -> bool {
    use std::time::Duration;

    // Try to send a simple packet and see if we get any response
    // This is a basic check - if something responds on UDP, assume it's us
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return false,
    };

    // Set timeout
    if socket
        .set_read_timeout(Some(Duration::from_millis(200)))
        .is_err()
    {
        return false;
    }

    // Send a minimal ping (just MAGIC_BYTES as a test)
    let magic = [0x53u8, 0x54, 0x5A, 0x48]; // "STZH"
    let target = format!("127.0.0.1:{}", port);
    if socket.send_to(&magic, &target).is_err() {
        return false;
    }

    // Try to receive any response
    let mut buf = [0u8; 64];
    socket.recv_from(&mut buf).is_ok()
}

/// Check if we can connect to TCP port (something listening)
async fn check_tcp_can_connect(port: u16) -> bool {
    use std::time::Duration;
    use tokio::net::TcpStream;

    let connect_result = tokio::time::timeout(
        Duration::from_millis(500),
        TcpStream::connect(format!("127.0.0.1:{}", port)),
    )
    .await;

    matches!(connect_result, Ok(Ok(_)))
}

/// Configure firewall with elevated privileges
/// This will prompt the user for admin/sudo access
pub async fn configure_firewall(app_name: &str, udp_port: u16, tcp_port: u16) -> FirewallResult {
    // SECURITY: Sanitize app_name to prevent command injection
    let safe_name = match sanitize_app_name(app_name) {
        Ok(name) => name,
        Err(e) => {
            return FirewallResult::Error {
                message: format!("Invalid app name: {}", e),
            }
        }
    };

    #[cfg(target_os = "windows")]
    {
        configure_firewall_windows(&safe_name, udp_port, tcp_port).await
    }

    #[cfg(target_os = "linux")]
    {
        configure_firewall_linux(&safe_name, udp_port, tcp_port).await
    }

    #[cfg(target_os = "macos")]
    {
        configure_firewall_macos(&safe_name, udp_port, tcp_port).await
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        FirewallResult::Error {
            message: "Unsupported platform".to_string(),
        }
    }
}

/// Check if firewall rules already exist
pub async fn check_firewall_rules_exist(app_name: &str) -> bool {
    // SECURITY: Sanitize app_name to prevent command injection
    let safe_name = match sanitize_app_name(app_name) {
        Ok(name) => name,
        Err(_) => return false, // Invalid name means no rules exist
    };

    #[cfg(target_os = "windows")]
    {
        check_firewall_rules_windows(&safe_name).await
    }

    #[cfg(target_os = "linux")]
    {
        check_firewall_rules_linux().await
    }

    #[cfg(target_os = "macos")]
    {
        // macOS app firewall doesn't have a simple check
        false
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

// ==================== Windows Implementation ====================

#[cfg(target_os = "windows")]
async fn configure_firewall_windows(
    app_name: &str,
    udp_port: u16,
    tcp_port: u16,
) -> FirewallResult {
    use std::os::windows::process::CommandExt;

    // Get the current executable path
    let exe_path = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            return FirewallResult::Error {
                message: format!("Failed to get executable path: {}", e),
            }
        }
    };

    // PowerShell script to add firewall rules
    // Using PowerShell allows us to add rules without netsh parsing issues
    let script = format!(
        r#"
        $ErrorActionPreference = 'Stop'
        try {{
            # Remove existing rules first
            Get-NetFirewallRule -DisplayName '{app_name} P2P UDP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            Get-NetFirewallRule -DisplayName '{app_name} P2P TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

            # Add UDP rule for discovery
            New-NetFirewallRule -DisplayName '{app_name} P2P UDP' `
                -Direction Inbound `
                -Protocol UDP `
                -LocalPort {udp_port} `
                -Action Allow `
                -Program '{exe_path}' `
                -Description 'Stuzhik P2P discovery'

            # Add TCP rule for file transfer
            New-NetFirewallRule -DisplayName '{app_name} P2P TCP' `
                -Direction Inbound `
                -Protocol TCP `
                -LocalPort {tcp_port} `
                -Action Allow `
                -Program '{exe_path}' `
                -Description 'Stuzhik P2P file transfer'

            Write-Host 'SUCCESS'
        }} catch {{
            Write-Host "ERROR: $($_.Exception.Message)"
            exit 1
        }}
        "#,
        app_name = app_name,
        udp_port = udp_port,
        tcp_port = tcp_port,
        exe_path = exe_path.replace("\\", "\\\\").replace("'", "''")
    );

    // First try without elevation (in case we already have admin rights)
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if stdout.contains("SUCCESS") {
                return FirewallResult::Success {
                    message: "Firewall rules configured successfully".to_string(),
                };
            }
        }
        _ => {}
    }

    // Need elevation - use PowerShell's Start-Process with -Verb RunAs
    let elevated_script = format!(
        r#"
        Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-NonInteractive', '-Command', @'
        {}
        '@
        "#,
        script.replace("'", "''")
    );

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &elevated_script,
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    match output {
        Ok(o) => {
            // Check if UAC was cancelled (exit code 1 with specific error)
            let stderr = String::from_utf8_lossy(&o.stderr);
            if stderr.contains("cancelled") || stderr.contains("The operation was canceled") {
                FirewallResult::Cancelled
            } else if o.status.success() {
                // Verify the rules were created
                if check_firewall_rules_windows(app_name).await {
                    FirewallResult::Success {
                        message: "Firewall rules configured successfully".to_string(),
                    }
                } else {
                    FirewallResult::Error {
                        message: "Rules may not have been created. Please try again.".to_string(),
                    }
                }
            } else {
                FirewallResult::Error {
                    message: format!(
                        "Failed to configure firewall: {}",
                        String::from_utf8_lossy(&o.stderr)
                    ),
                }
            }
        }
        Err(e) => FirewallResult::Error {
            message: format!("Failed to execute PowerShell: {}", e),
        },
    }
}

#[cfg(target_os = "windows")]
async fn check_firewall_rules_windows(app_name: &str) -> bool {
    use std::os::windows::process::CommandExt;

    let script = format!(
        r#"
        $udp = Get-NetFirewallRule -DisplayName '{} P2P UDP' -ErrorAction SilentlyContinue
        $tcp = Get-NetFirewallRule -DisplayName '{} P2P TCP' -ErrorAction SilentlyContinue
        if ($udp -and $tcp) {{ Write-Host 'EXISTS' }}
        "#,
        app_name, app_name
    );

    match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .output()
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("EXISTS"),
        Err(_) => false,
    }
}

// ==================== Linux Implementation ====================

#[cfg(target_os = "linux")]
async fn configure_firewall_linux(_app_name: &str, udp_port: u16, tcp_port: u16) -> FirewallResult {
    // Try pkexec first (graphical sudo prompt)
    // Then fall back to polkit or regular sudo

    // Check if ufw is available
    let has_ufw = Command::new("which")
        .arg("ufw")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    // Check if firewalld is available
    let has_firewalld = Command::new("which")
        .arg("firewall-cmd")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if has_ufw {
        configure_ufw(udp_port, tcp_port).await
    } else if has_firewalld {
        configure_firewalld(udp_port, tcp_port).await
    } else {
        // Try iptables as last resort
        configure_iptables(udp_port, tcp_port).await
    }
}

#[cfg(target_os = "linux")]
async fn configure_ufw(udp_port: u16, tcp_port: u16) -> FirewallResult {
    // Use pkexec for graphical elevation
    let commands = vec![
        format!("ufw allow {}/udp comment 'Stuzhik P2P'", udp_port),
        format!("ufw allow {}/tcp comment 'Stuzhik P2P'", tcp_port),
    ];

    for cmd in commands {
        let result = Command::new("pkexec").args(["sh", "-c", &cmd]).output();

        match result {
            Ok(o) if o.status.success() => continue,
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                if stderr.contains("dismissed") || stderr.contains("cancelled") {
                    return FirewallResult::Cancelled;
                }
                return FirewallResult::Error {
                    message: format!("UFW error: {}", stderr),
                };
            }
            Err(e) => {
                return FirewallResult::Error {
                    message: format!("Failed to run pkexec: {}", e),
                }
            }
        }
    }

    FirewallResult::Success {
        message: "UFW rules configured successfully".to_string(),
    }
}

#[cfg(target_os = "linux")]
async fn configure_firewalld(udp_port: u16, tcp_port: u16) -> FirewallResult {
    let commands = vec![
        format!("firewall-cmd --permanent --add-port={}/udp", udp_port),
        format!("firewall-cmd --permanent --add-port={}/tcp", tcp_port),
        "firewall-cmd --reload".to_string(),
    ];

    for cmd in commands {
        let result = Command::new("pkexec").args(["sh", "-c", &cmd]).output();

        match result {
            Ok(o) if o.status.success() => continue,
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                if stderr.contains("dismissed") || stderr.contains("cancelled") {
                    return FirewallResult::Cancelled;
                }
                return FirewallResult::Error {
                    message: format!("firewalld error: {}", stderr),
                };
            }
            Err(e) => {
                return FirewallResult::Error {
                    message: format!("Failed to run pkexec: {}", e),
                }
            }
        }
    }

    FirewallResult::Success {
        message: "Firewalld rules configured successfully".to_string(),
    }
}

#[cfg(target_os = "linux")]
async fn configure_iptables(udp_port: u16, tcp_port: u16) -> FirewallResult {
    let commands = vec![
        format!(
            "iptables -I INPUT -p udp --dport {} -j ACCEPT -m comment --comment 'Stuzhik P2P'",
            udp_port
        ),
        format!(
            "iptables -I INPUT -p tcp --dport {} -j ACCEPT -m comment --comment 'Stuzhik P2P'",
            tcp_port
        ),
    ];

    for cmd in commands {
        let result = Command::new("pkexec").args(["sh", "-c", &cmd]).output();

        match result {
            Ok(o) if o.status.success() => continue,
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                if stderr.contains("dismissed") || stderr.contains("cancelled") {
                    return FirewallResult::Cancelled;
                }
                return FirewallResult::Error {
                    message: format!("iptables error: {}", stderr),
                };
            }
            Err(e) => {
                return FirewallResult::Error {
                    message: format!("Failed to run pkexec: {}", e),
                }
            }
        }
    }

    FirewallResult::Success {
        message: "iptables rules configured successfully".to_string(),
    }
}

#[cfg(target_os = "linux")]
async fn check_firewall_rules_linux() -> bool {
    // Check UFW
    if let Ok(o) = Command::new("ufw").arg("status").output() {
        let stdout = String::from_utf8_lossy(&o.stdout);
        if stdout.contains("Stuzhik") {
            return true;
        }
    }

    // Check firewalld
    if let Ok(o) = Command::new("firewall-cmd").arg("--list-ports").output() {
        let stdout = String::from_utf8_lossy(&o.stdout);
        if stdout.contains("19847") || stdout.contains("19848") {
            return true;
        }
    }

    false
}

// ==================== macOS Implementation ====================

#[cfg(target_os = "macos")]
async fn configure_firewall_macos(
    app_name: &str,
    _udp_port: u16,
    _tcp_port: u16,
) -> FirewallResult {
    // macOS uses the Application Firewall which works per-app, not per-port
    // We need to add the app to the firewall exceptions

    let exe_path = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            return FirewallResult::Error {
                message: format!("Failed to get executable path: {}", e),
            }
        }
    };

    // Use osascript to run with admin privileges
    let script = format!(
        r#"
        do shell script "/usr/libexec/ApplicationFirewall/socketfilterfw --add '{}' && /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '{}'" with administrator privileges
        "#,
        exe_path, exe_path
    );

    let result = Command::new("osascript").args(["-e", &script]).output();

    match result {
        Ok(o) if o.status.success() => FirewallResult::Success {
            message: "Application added to firewall exceptions".to_string(),
        },
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if stderr.contains("User canceled") || stderr.contains("cancelled") {
                FirewallResult::Cancelled
            } else {
                FirewallResult::Error {
                    message: format!("Firewall configuration failed: {}", stderr),
                }
            }
        }
        Err(e) => FirewallResult::Error {
            message: format!("Failed to run osascript: {}", e),
        },
    }
}

/// Get a human-readable explanation of what firewall configuration will do
pub fn get_firewall_explanation(udp_port: u16, tcp_port: u16) -> String {
    #[cfg(target_os = "windows")]
    {
        format!(
            "This will create Windows Firewall rules to allow:\n\
             • UDP port {} (P2P discovery)\n\
             • TCP port {} (file transfer)\n\n\
             You will be prompted for administrator permission.",
            udp_port, tcp_port
        )
    }

    #[cfg(target_os = "linux")]
    {
        format!(
            "This will configure your firewall to allow:\n\
             • UDP port {} (P2P discovery)\n\
             • TCP port {} (file transfer)\n\n\
             You will be prompted for your password.",
            udp_port, tcp_port
        )
    }

    #[cfg(target_os = "macos")]
    {
        let _ = (udp_port, tcp_port); // silence unused warnings
        "This will add Stuzhik to your macOS firewall exceptions.\n\
         You will be prompted for your password."
            .to_string()
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        format!(
            "Please manually configure your firewall to allow:\n\
             • UDP port {} (P2P discovery)\n\
             • TCP port {} (file transfer)",
            udp_port, tcp_port
        )
    }
}

/// Remove firewall rules created by Stuzhik
pub async fn remove_firewall_rules(app_name: &str) -> FirewallResult {
    // SECURITY: Sanitize app_name to prevent command injection
    let safe_name = match sanitize_app_name(app_name) {
        Ok(name) => name,
        Err(e) => {
            return FirewallResult::Error {
                message: format!("Invalid app name: {}", e),
            }
        }
    };

    #[cfg(target_os = "windows")]
    {
        remove_firewall_rules_windows(&safe_name).await
    }

    #[cfg(target_os = "linux")]
    {
        remove_firewall_rules_linux(&safe_name).await
    }

    #[cfg(target_os = "macos")]
    {
        // macOS doesn't add persistent rules the same way
        FirewallResult::Success {
            message: "macOS firewall rules are session-based".to_string(),
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        FirewallResult::Error {
            message: "Unsupported platform".to_string(),
        }
    }
}

#[cfg(target_os = "windows")]
async fn remove_firewall_rules_windows(app_name: &str) -> FirewallResult {
    use std::os::windows::process::CommandExt;

    let script = format!(
        r#"
        $ErrorActionPreference = 'Stop'
        $removed = 0
        try {{
            $rule1 = Get-NetFirewallRule -DisplayName '{app_name} P2P UDP' -ErrorAction SilentlyContinue
            if ($rule1) {{
                Remove-NetFirewallRule -DisplayName '{app_name} P2P UDP'
                $removed++
            }}
            $rule2 = Get-NetFirewallRule -DisplayName '{app_name} P2P TCP' -ErrorAction SilentlyContinue
            if ($rule2) {{
                Remove-NetFirewallRule -DisplayName '{app_name} P2P TCP'
                $removed++
            }}
            if ($removed -gt 0) {{
                Write-Host "SUCCESS:$removed"
            }} else {{
                Write-Host "NONE"
            }}
        }} catch {{
            Write-Host "ERROR: $($_.Exception.Message)"
            exit 1
        }}
        "#,
        app_name = app_name
    );

    // Try without elevation first
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if stdout.contains("SUCCESS") {
                return FirewallResult::Success {
                    message: "Firewall rules removed".to_string(),
                };
            } else if stdout.contains("NONE") {
                return FirewallResult::Success {
                    message: "No rules to remove".to_string(),
                };
            }
        }
        _ => {}
    }

    // Need elevation
    let elevated_script = format!(
        r#"Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-NonInteractive', '-Command', @'
{}
'@"#,
        script
    );

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &elevated_script,
        ])
        .creation_flags(0x08000000)
        .output();

    match output {
        Ok(o) if o.status.success() => FirewallResult::Success {
            message: "Firewall rules removed".to_string(),
        },
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if stderr.contains("canceled") || stderr.contains("cancelled") {
                FirewallResult::Cancelled
            } else {
                FirewallResult::Error {
                    message: format!("Failed to remove rules: {}", stderr),
                }
            }
        }
        Err(e) => FirewallResult::Error {
            message: format!("Failed to run PowerShell: {}", e),
        },
    }
}

#[cfg(target_os = "linux")]
async fn remove_firewall_rules_linux(app_name: &str) -> FirewallResult {
    // Detect firewall type and remove rules
    let ufw_check = Command::new("which").arg("ufw").output();

    if ufw_check.map(|o| o.status.success()).unwrap_or(false) {
        // UFW - remove by comment
        let script = format!("ufw delete allow comment '{}'", app_name);

        let output = Command::new("pkexec")
            .args(["bash", "-c", &script])
            .output();

        match output {
            Ok(o) if o.status.success() => FirewallResult::Success {
                message: "Firewall rules removed".to_string(),
            },
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                if stderr.contains("dismissed") || stderr.contains("cancelled") {
                    FirewallResult::Cancelled
                } else {
                    FirewallResult::Error {
                        message: format!("Failed: {}", stderr),
                    }
                }
            }
            Err(e) => FirewallResult::Error {
                message: format!("Failed to run pkexec: {}", e),
            },
        }
    } else {
        FirewallResult::Error {
            message: "Could not detect firewall type".to_string(),
        }
    }
}

// Note: Tauri commands for network diagnostics are defined in lib.rs to avoid duplication
