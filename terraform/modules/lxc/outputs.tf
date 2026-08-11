output "vm_id" {
  description = "Container ID assigned by Proxmox"
  value       = proxmox_virtual_environment_container.this.vm_id
}

output "hostname" {
  value = var.hostname
}

output "node_name" {
  value = proxmox_virtual_environment_container.this.node_name
}

output "ipv4_address" {
  description = "Configured address without the CIDR suffix (empty when DHCP)"
  value       = var.ipv4_address == "dhcp" ? "" : split("/", var.ipv4_address)[0]
}
