terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = ">= 0.111"
    }
  }
}

resource "proxmox_virtual_environment_container" "this" {
  node_name     = var.node_name
  vm_id         = var.vm_id != 0 ? var.vm_id : null
  description   = var.description
  tags          = var.tags
  pool_id       = var.pool_id
  unprivileged  = var.unprivileged
  start_on_boot = var.start_on_boot
  started       = var.started
  protection    = var.protection

  operating_system {
    template_file_id = var.template_file_id
    type             = var.os_type
  }

  initialization {
    hostname = var.hostname

    ip_config {
      ipv4 {
        address = var.ipv4_address
        gateway = var.ipv4_address == "dhcp" ? null : var.ipv4_gateway
      }
    }

    dynamic "dns" {
      for_each = length(var.dns_servers) > 0 || var.dns_domain != null ? [1] : []
      content {
        domain  = var.dns_domain
        servers = var.dns_servers
      }
    }

    user_account {
      keys     = var.ssh_public_keys
      password = var.root_password
    }
  }

  cpu {
    cores = var.cores
  }

  memory {
    dedicated = var.memory
    swap      = var.swap
  }

  disk {
    datastore_id = var.datastore_id
    size         = var.disk_size
  }

  network_interface {
    name     = "eth0"
    bridge   = var.bridge
    mtu      = var.mtu
    vlan_id  = var.vlan_id
    firewall = false
  }

  features {
    nesting = var.nesting
    keyctl  = var.keyctl
    fuse    = var.fuse
  }

  dynamic "mount_point" {
    for_each = var.mount_points
    content {
      volume    = mount_point.value.volume
      path      = mount_point.value.path
      size      = mount_point.value.size
      backup    = mount_point.value.backup
      read_only = mount_point.value.read_only
    }
  }

  lifecycle {
    # The template is only read at creation time; changing it would force a
    # rebuild that silently destroys the container's data.
    ignore_changes = [operating_system[0].template_file_id]
  }
}
