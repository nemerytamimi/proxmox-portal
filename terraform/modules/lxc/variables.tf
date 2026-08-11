variable "hostname" {
  description = "Container hostname (also used as the PVE name)"
  type        = string
}

variable "node_name" {
  description = "PVE node to create the container on"
  type        = string
}

variable "vm_id" {
  description = "Container ID. 0 lets Proxmox pick the next free one."
  type        = number
  default     = 0
}

variable "template_file_id" {
  description = "CT template volume id, e.g. local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst"
  type        = string
}

variable "os_type" {
  description = "OS family of the template (debian, ubuntu, alpine, centos, ...)"
  type        = string
  default     = "debian"
}

variable "cores" {
  type    = number
  default = 1
}

variable "memory" {
  description = "RAM in MiB"
  type        = number
  default     = 512
}

variable "swap" {
  description = "Swap in MiB"
  type        = number
  default     = 512
}

variable "disk_size" {
  description = "Root filesystem size in GiB"
  type        = number
  default     = 8
}

variable "datastore_id" {
  type    = string
  default = "local"
}

variable "bridge" {
  type    = string
  default = "vmbr1"
}

variable "mtu" {
  type    = number
  default = 0
}

variable "vlan_id" {
  type    = number
  default = null
}

variable "ipv4_address" {
  description = "CIDR address (10.98.3.50/24) or \"dhcp\""
  type        = string
}

variable "ipv4_gateway" {
  description = "Gateway; leave null when ipv4_address is \"dhcp\""
  type        = string
  default     = null
}

variable "dns_servers" {
  type    = list(string)
  default = []
}

variable "dns_domain" {
  type    = string
  default = null
}

variable "ssh_public_keys" {
  type    = list(string)
  default = []
}

variable "root_password" {
  description = "Optional root password. Leave null to allow key-based login only."
  type        = string
  default     = null
  sensitive   = true
}

variable "unprivileged" {
  type    = bool
  default = true
}

variable "nesting" {
  description = "Enable the nesting feature (required to run Docker inside the CT)"
  type        = bool
  default     = true
}

variable "keyctl" {
  type    = bool
  default = false
}

variable "fuse" {
  type    = bool
  default = false
}

variable "start_on_boot" {
  type    = bool
  default = true
}

variable "started" {
  type    = bool
  default = true
}

variable "protection" {
  description = "Block destroy/remove operations in Proxmox"
  type        = bool
  default     = false
}

variable "tags" {
  type    = list(string)
  default = ["terraform"]
}

variable "description" {
  type    = string
  default = "Managed by Terraform"
}

variable "pool_id" {
  type    = string
  default = null
}

variable "mount_points" {
  description = <<-EOT
    Extra mount points. Example:
      [{ volume = "local", size = "20G", path = "/data" }]         # new volume
      [{ volume = "/mnt/pve/storage1/x", path = "/data" }]         # bind mount
  EOT
  type = list(object({
    volume    = string
    path      = string
    size      = optional(string)
    backup    = optional(bool, false)
    read_only = optional(bool, false)
  }))
  default = []
}
