class Jazz < Formula
  desc "AI agent that actually does things - autonomous task execution with 44+ tools"
  homepage "https://github.com/lvndry/jazz"
  version "0.8.1"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/lvndry/jazz/releases/download/v0.8.1/jazz-darwin-arm64"
      sha256 "REPLACE_WITH_ACTUAL_SHA256_ARM64"
    else
      url "https://github.com/lvndry/jazz/releases/download/v0.8.1/jazz-darwin-x64"
      sha256 "REPLACE_WITH_ACTUAL_SHA256_X64"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/lvndry/jazz/releases/download/v0.8.1/jazz-linux-arm64"
      sha256 "REPLACE_WITH_ACTUAL_SHA256_LINUX_ARM64"
    else
      url "https://github.com/lvndry/jazz/releases/download/v0.8.1/jazz-linux-x64"
      sha256 "REPLACE_WITH_ACTUAL_SHA256_LINUX_X64"
    end
  end

  def install
    os = OS.mac? ? "darwin" : "linux"
    arch = Hardware::CPU.arm? ? "arm64" : "x64"
    bin.install "jazz-#{os}-#{arch}" => "jazz"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/jazz --version")
  end
end
